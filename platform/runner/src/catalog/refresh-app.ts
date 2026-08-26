import { api } from './github'
import type { Entry } from './refresh-catalog'
import { compare, parseVersion, version } from './version'

/**
 * Rung 4 is first-party only while the abuse model is unproven. Deliberately
 * not shared with the catalog repository's owner in `refresh-catalog.ts`: they
 * are the same string today and two independent facts — moving the catalog to
 * another org must not quietly hand rolling releases to that org's apps.
 */
const FIRST_PARTY = 'justfiles/'

/** Rung 3 pages the tags endpoint, but not without end. 300 tags is plenty. */
const TAG_PAGES = 3

const recordKey = (id: string) => `apps/${id}/record.json`

/** Which conditional read an ETag belongs to. Bounded: one per probe, no more. */
type Probe = 'release' | 'head'

/** A release resolved to immutable bytes, before any of them have been fetched. */
export interface Resolved {
	/** Normalised from the tag, or the commit's day and sha at rung 4. */
	version: string
	/** Which step of the ladder matched — kb/catalog.md#release-resolution. */
	rung: 1 | 2 | 3 | 4
	/** The tag, or the default branch at rung 4. */
	ref: string
	/** Resolved separately from `ref`, because tags move. */
	commit: string
	/** The release asset at rung 1. Rungs 2–4 take the repo zipball at `commit`. */
	assetId?: number
}

/**
 * A resolution whose bytes we hold. Frozen: a re-resolution landing on the same
 * version is compared, never rewritten.
 *
 * There is no `staging` state. `record.json` is written once every file has
 * landed, so a half-finished import leaves bytes in storage and no record here —
 * which is exactly the orphan the GC sweep in kb/registry.md looks for.
 */
export interface Release extends Resolved {
	/**
	 * Provenance of the archive we downloaded, and nothing derived from the
	 * manifest: the release's own `hash` lives in the manifest, and a second copy
	 * here would be a second thing that can disagree.
	 */
	bundle: {
		/** Of `bundle.zip` as we received it. */
		digest: string
		/** Of `bundle.zip`, compressed. */
		size: number
		/** Everything it extracted to, the authored manifest included. */
		unpacked: number
	}
	state: 'ready' | 'yanked'
	at: number
}

/**
 * Everything we learned about one app by importing it — the right-hand column
 * of kb/registry.md's table, and the half nothing can reconstruct. `repo` and
 * `status` are absent on purpose: one read of the catalog produces them.
 */
export interface AppRecord {
	/** GitHub's immutable repository id. Empty until first learned. */
	repoNodeId: string
	/** Where rung 4 looks; learned from the same response as `repoNodeId`. */
	defaultBranch: string
	/** THE pointer — writing it is publishing. Null until the first import completes. */
	current: string | null
	/** Poll state. Advanced only by a run that left nothing undone; see below. */
	etags: Partial<Record<Probe, string>>
	checkedAt: number
	/** Last failure, retried next run independent of the catalog cursor. */
	error: string | null
	releases: Record<string, Release>
}

interface RepoMeta {
	node_id: string
	default_branch: string
}

/**
 * Poll one app and resolve what it ought to be serving. Returns the release we
 * do not hold yet, or null when there is nothing to fetch.
 *
 * Fetching is deliberately elsewhere — see `import.ts`.
 */
export async function refreshApp(
	env: CloudflareBindings,
	id: string,
	entry: Entry
): Promise<Resolved | null> {
	// Outside the try: a corrupt `record.json` must not be overwritten with a blank
	// one. Unlike the catalog snapshot, nothing upstream could rebuild it.
	const before = await readRecord(env, id)

	// What this run's polls saw. Written back only if it leaves nothing undone.
	const polled: AppRecord['etags'] = { ...before?.etags }

	/**
	 * Identity is checked where it matters: before bytes are taken in, and at
	 * rung 4, which needs the default branch out of the same response. A GitHub
	 * login is not permanent — free one and a stranger can answer to the same
	 * `owner/name`, which the string comparison in the entry cannot catch.
	 *
	 * Not on every poll, because `/repos/{o}/{r}` carries the star count and so
	 * almost never 304s. A hijacked repository cannot change what we already
	 * serve; it can only try to become the next release, and this is that door.
	 */
	let meta: RepoMeta | null = null
	const repoMeta = async (repo: string) => {
		if (meta) return meta
		const res = await api(env, `/repos/${repo}`)
		if (!res.ok) throw new Error(`repo: ${res.status}`)
		const fetched = await res.json<RepoMeta>()
		if (before?.repoNodeId && before.repoNodeId !== fetched.node_id)
			throw new Error(`repo identity changed: ${before.repoNodeId} → ${fetched.node_id}`)
		meta = fetched
		return fetched
	}

	const save = (etags: AppRecord['etags'], error: string | null) =>
		writeRecord(env, id, {
			repoNodeId: meta?.node_id ?? before?.repoNodeId ?? '',
			defaultBranch: meta?.default_branch ?? before?.defaultBranch ?? '',
			current: before?.current ?? null,
			etags,
			checkedAt: Math.floor(Date.now() / 1000),
			error,
			// Carried through untouched. Recording a release is the import's write,
			// and it has to come after the manifest — see kb/registry.md#import.
			releases: before?.releases ?? {}
		})

	try {
		if (!entry.repo) throw new Error('entry has no repo')
		const resolved = await resolveRelease(env, entry, entry.repo, polled, repoMeta)
		const held = resolved ? before?.releases[resolved.version] : undefined

		// A version is frozen once written, so a tag that moved under us is a flag
		// rather than an overwrite — the failure Go's checksum database exists to
		// catch, made structural here by keying the bytes on the version.
		if (resolved && held && held.commit !== resolved.commit)
			console.warn(`${id} ${resolved.version}: commit moved ${held.commit} → ${resolved.commit}`)

		const pending = held ? null : resolved
		if (pending) await repoMeta(entry.repo)

		// The ETags record what we have finished with, not what we have seen. While
		// an import is outstanding they stay where they were, so the next run cannot
		// 304 past work it never did.
		await save(pending ? (before?.etags ?? {}) : polled, null)
		return pending
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err)
		console.error(`${id}:`, error)
		await save(before?.etags ?? {}, error)
		return null
	}
}

/**
 * The resolution ladder of kb/catalog.md#release-resolution, walked from the top
 * every run: an app graduates a rung by pushing a tag, and nothing announces it.
 *
 * Null means nothing changed upstream. It is only ever returned where a stored
 * ETag proves the previous run finished, which is what makes skipping safe.
 */
async function resolveRelease(
	env: CloudflareBindings,
	entry: Entry,
	repo: string,
	etags: AppRecord['etags'],
	repoMeta: (repo: string) => Promise<RepoMeta>
): Promise<Resolved | null> {
	// Rungs 1–2: the latest release. Its ETag is the whole optimisation — most
	// apps release rarely, so most runs stop here having spent nothing.
	const latest = await poll(env, etags, 'release', `/repos/${repo}/releases/latest`)
	if (latest.status === 304) return null
	if (latest.ok) {
		const release = await latest.json<{ tag_name: string; assets: Asset[] }>()
		const assetId = pickAsset(release.assets, entry.asset, repo)
		return {
			version: version(release.tag_name),
			rung: assetId === undefined ? 2 : 1,
			ref: release.tag_name,
			commit: await commitOf(env, repo, release.tag_name),
			assetId
		}
	}
	if (latest.status !== 404) throw new Error(`releases/latest: ${latest.status}`)

	// Rung 3: the newest semver tag. Deliberately not conditional — GitHub makes
	// no promise about tag order, so a 304 on the first page would not prove that
	// no new tag had landed on a later one.
	const tag = await newestTag(env, repo)
	if (tag) return { ...tag, rung: 3, commit: await commitOf(env, repo, tag.ref) }

	// Rung 4: the default branch, rolling. A third party is told to push a tag,
	// which costs one command and pins every release to an immutable ref.
	// Lifting the restriction is this condition.
	if (!repo.startsWith(FIRST_PARTY)) throw new Error('no releases and no tags: push a tag')
	const branch = (await repoMeta(repo)).default_branch
	const head = await poll(env, etags, 'head', `/repos/${repo}/commits/${branch}`)
	if (head.status === 304) return null
	if (!head.ok) throw new Error(`commits/${branch}: ${head.status}`)

	const { sha, commit } = await head.json<{
		sha: string
		commit: { committer: { date: string } }
	}>()
	// The commit's day, never today's: the same HEAD would otherwise mint a new
	// version every midnight and re-import itself for ever.
	const day = commit.committer.date.slice(0, 10).replaceAll('-', '')
	return { version: `${day}.${sha.slice(0, 7)}`, rung: 4, ref: branch, commit: sha }
}

/**
 * A conditional GET whose ETag is remembered under `probe`. The 304 is the whole
 * point: correctly authorized it does not count against the primary rate limit
 * and carries no body, so an app that has not released costs nothing to ask.
 */
async function poll(
	env: CloudflareBindings,
	etags: AppRecord['etags'],
	probe: Probe,
	path: string
): Promise<Response> {
	const res = await api(env, path, etags[probe])
	if (res.ok) {
		const etag = res.headers.get('etag')
		if (etag) etags[probe] = etag
		else delete etags[probe]
	}
	return res
}

interface Asset {
	id: number
	name: string
}

/**
 * kb/catalog.md#which-asset-when-rung-1-hits, most specific first. Undefined
 * means no zip at all, which is rung 2 rather than a failure.
 */
function pickAsset(assets: Asset[], want: string | undefined, repo: string): number | undefined {
	const named = want ? assets.find((a) => a.name === want) : undefined
	if (named) return named.id
	// A stale override falls through rather than failing. An author who renames
	// their bundle should not have releases stop until a catalog PR lands.
	if (want) console.warn(`${repo}: asset "${want}" not found, falling through`)

	const zips = assets.filter((a) => a.name.endsWith('.zip'))
	const [only] = zips
	if (only && zips.length === 1) return only.id
	const app = zips.find((a) => a.name === 'app.zip')
	if (app) return app.id
	if (zips.length) throw new Error(`several zips, none app.zip: ${zips.map((z) => z.name).join()}`)
	return undefined
}

/**
 * The newest semver tag, paged and capped. One page is wrong on any repository
 * with more than a hundred tags; paging without end is not worth spending on one
 * with five hundred. The tag comes back beside the version because the tag is
 * the ref we fetch and the version is only its normalised form.
 */
async function newestTag(
	env: CloudflareBindings,
	repo: string
): Promise<{ ref: string; version: string } | null> {
	let best: { ref: string; version: string } | null = null
	for (let page = 1; page <= TAG_PAGES; page++) {
		const res = await api(env, `/repos/${repo}/tags?per_page=100&page=${page}`)
		if (!res.ok) throw new Error(`tags: ${res.status}`)
		const batch = await res.json<{ name: string }[]>()
		for (const { name } of batch) {
			const v = parseVersion(name)
			if (v && (!best || compare(v, best.version) > 0)) best = { ref: name, version: v }
		}
		if (batch.length < 100) break
	}
	return best
}

/**
 * The commit a ref points at. Resolved separately because tags move, and
 * `/commits/{ref}` follows an annotated tag to its commit in one request where
 * the git-ref endpoints take two.
 */
async function commitOf(env: CloudflareBindings, repo: string, ref: string): Promise<string> {
	const res = await api(env, `/repos/${repo}/commits/${encodeURIComponent(ref)}`)
	if (!res.ok) throw new Error(`commit ${ref}: ${res.status}`)
	return (await res.json<{ sha: string }>()).sha
}

/** Also the serving path's one lookup — the current pointer lives here. */
export async function readRecord(env: CloudflareBindings, id: string): Promise<AppRecord | null> {
	const obj = await env.STORE.get(recordKey(id))
	return obj ? await obj.json<AppRecord>() : null
}

/**
 * Two writers, by design: this module writes `etags`, and the import writes
 * `releases` and `current`. Both read-modify-write the whole document, and both
 * run once per app per run, in that order.
 */
export const writeRecord = (env: CloudflareBindings, id: string, record: AppRecord) =>
	env.STORE.put(recordKey(id), JSON.stringify(record), {
		httpMetadata: { contentType: 'application/json' }
	})
