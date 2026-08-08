import { api, graphql } from './github'

const OWNER = 'justfiles'
const NAME = 'app-catalog'
const BRANCH = 'main'
const CATALOG_KEY = 'catalog.json'

/**
 * Bumped whenever the stored shape changes — a field the parser starts reading,
 * or one it stops writing. The snapshot is a projection of an upstream commit,
 * so a stale one is rebuilt rather than migrated, which is what lets this shape
 * change later without touching any data we already hold.
 */
const SCHEMA = 2

/**
 * One `apps/<id>.json` of the catalog, keyed by that id.
 *
 * The id is the key and never a field, exactly as the catalog makes it the
 * filename and never a field: with one copy there is nothing to disagree, and
 * the container enforces uniqueness — of the id, and so of the origin derived
 * from it. Anything holding an `Entry` reached it through its id, so nothing
 * needs it repeated inside.
 *
 * v1 reads no rename fields. An entry carrying `to` or `formerIds` parks on the
 * `status` rule below instead of being followed; supporting them later is this
 * type, `parseEntry`, and a `SCHEMA` bump.
 */
export interface Entry {
	/** `owner/name`. Absent on a tombstone, which points nowhere. */
	repo?: string
	/**
	 * Read as `=== 'active'`, so anything else — including a status this version
	 * does not know, such as `renamed` — parks the app rather than failing open.
	 */
	status: 'active' | 'removed'
	/** Release-asset name override; an escape hatch, not configuration. */
	asset?: string
}

/** The catalog at one commit, plus what we need in order to ask for the next. */
export interface Catalog {
	schema: number
	sha: string
	/** From the commits endpoint, so the next poll can be conditional. */
	etag: string | null
	entries: Record<string, Entry>
}

export interface CatalogRefresh {
	/** The snapshot now in R2 — this run's, or the unchanged previous one. */
	catalog: Catalog
	/**
	 * Ids whose entry differs from the previous snapshot. Advisory: entry
	 * reconciliation is state-driven, so a run that misses this list still
	 * converges. It exists to skip work and to report.
	 */
	touched: string[]
	/**
	 * Ids whose file vanished. Never expected — an entry is tombstoned, never
	 * deleted, because deleting one makes its id (and its origin) claimable
	 * again. Non-empty means someone should look.
	 */
	deleted: string[]
}

/**
 * Bring our snapshot of `justfiles/app-catalog` up to date, and report what
 * moved. See kb/registry.md.
 *
 * Desired state lives in that repository and is never mirrored field by field —
 * but it *is* snapshotted whole, at a pinned commit, because every later phase
 * needs each app's `repo` on every run, and re-fetching the catalog to learn
 * nothing is precisely what a cursor exists to avoid.
 *
 * The snapshot is the cursor. Two objects each claiming "the commit we last
 * processed" can disagree; one cannot.
 */
export async function refreshCatalog(env: CloudflareBindings): Promise<CatalogRefresh> {
	const previous = await readCatalog(env)

	// The common case is that nothing has been merged, and one conditional
	// request settles it: a 304 costs no rate limit and carries no body.
	const head = await api(env, `/repos/${OWNER}/${NAME}/commits/${BRANCH}`, previous?.etag)
	if (head.status === 304 && previous) return { catalog: previous, touched: [], deleted: [] }
	if (!head.ok) throw new Error(`catalog head: ${head.status}`)

	// `sha` and `etag` are paired: the ETag we store is the one that identifies
	// this commit, so the next conditional request means what it says.
	const { sha } = await head.json<{ sha: string }>()
	if (previous?.sha === sha) return { catalog: previous, touched: [], deleted: [] }

	// Read after the head, so a merge landing in between leaves the recorded sha
	// *behind* the entries rather than ahead of them. That direction is benign:
	// the next run sees a different ETag and re-reads. The reverse would skip.
	const entries = await fetchEntries(env)
	const catalog: Catalog = { schema: SCHEMA, sha, etag: head.headers.get('etag'), entries }

	// Diff before the write, which is when the previous snapshot stops existing.
	const before = previous?.entries ?? {}
	const same = (id: string) => JSON.stringify(before[id]) === JSON.stringify(entries[id])
	const touched = Object.keys(entries).filter((id) => !same(id))
	const deleted = Object.keys(before).filter((id) => !(id in entries))

	await env.STORE.put(CATALOG_KEY, JSON.stringify(catalog), {
		httpMetadata: { contentType: 'application/json' }
	})
	return { catalog, touched, deleted }
}

/** The snapshot as it stands, without asking upstream anything. */
export async function readCatalog(env: CloudflareBindings): Promise<Catalog | null> {
	const obj = await env.STORE.get(CATALOG_KEY)
	if (!obj) return null
	try {
		const catalog = await obj.json<Catalog>()
		// A snapshot written before `parseEntry` learned a field is missing that
		// field. Treating it as absent rebuilds it from upstream on the next run,
		// so there is never anything to migrate.
		return catalog.schema === SCHEMA ? catalog : null
	} catch {
		// The snapshot is only ever a copy of an immutable commit, so a corrupt
		// one costs a re-read rather than anything unrecoverable.
		return null
	}
}

/**
 * Resolves one `apps` tree and its blobs, so the entry set cannot tear no
 * matter what merges while we read.
 *
 * **Do not "improve" this to `<sha>:apps`.** GitHub resolves a bare 40-character
 * SHA, and resolves `<short-sha>:path`, but returns null for a full SHA with a
 * path — verified against this repository. A ref expression is the ordinary
 * form and the one that works.
 */
const TREE = `query($owner:String!,$name:String!,$expr:String!){
	repository(owner:$owner,name:$name){
		object(expression:$expr){ ...on Tree{ entries{ name object{ ...on Blob{ text } } } } }
	}
}`

interface TreeData {
	repository?: { object?: { entries?: { name: string; object?: { text?: string } }[] } }
}

/**
 * Every entry, in one request.
 *
 * The alternatives all read the whole directory too, and cost more: a file at a
 * time means N unauthenticated `raw.githubusercontent.com` fetches against a
 * per-IP limit we share and cannot raise, and an archive means a tar reader
 * nothing else here would use — releases are ZIPs. A tree read bills at ~1
 * point and needs no parser.
 *
 * The reason not to use GraphQL generally — no conditional requests — does not
 * apply: the ETag on `commits/main` has already established that something
 * changed before this runs.
 *
 * Revisit once rung 1 forces a streaming ZIP reader to exist; the catalog as a
 * zipball would then be reuse rather than a second parser.
 */
async function fetchEntries(env: CloudflareBindings): Promise<Record<string, Entry>> {
	const data = await graphql<TreeData>(env, TREE, {
		owner: OWNER,
		name: NAME,
		expr: `refs/heads/${BRANCH}:apps`
	})

	const nodes = data.repository?.object?.entries
	if (!nodes) throw new Error('catalog tree: no apps/ directory')

	return Object.fromEntries(
		nodes
			.filter((n) => n.name.endsWith('.json'))
			.map((n) => {
				// `text` is null for a binary or oversized blob. Fail the whole refresh
				// rather than write a snapshot missing an app: a partial snapshot reads
				// as a deletion, and deletion is the one thing this catalog cannot say.
				if (n.object?.text == null) throw new Error(`catalog entry ${n.name}: unreadable`)
				// The filename is the id, minus the extension — never a field inside.
				return [n.name.slice(0, -'.json'.length), parseEntry(JSON.parse(n.object.text))]
			})
	)
}

/**
 * Unknown fields are dropped rather than carried, so the snapshot only ever
 * holds what this version acts on. Field order is fixed so that
 * `JSON.stringify` is a usable equality test.
 */
function parseEntry(raw: unknown): Entry {
	const e = raw as Partial<Entry>
	return { repo: e.repo, status: e.status ?? 'active', asset: e.asset }
}
