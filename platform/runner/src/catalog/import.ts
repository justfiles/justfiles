import { type AppManifest, safeBundlePath } from '@justfiles/app'
import type { CatalogFile } from '@justfiles/app/appstore'
import { appHash, releaseManifest } from '@justfiles/app/appstore/protocol'
import { archive } from './github'
import { type AppRecord, type Release, type Resolved, readRecord, writeRecord } from './refresh-app'
import { entries, inflate, readCapped, type ZipEntry } from './zip'

/**
 * Bounds, from kb/catalog.md#security-boundary. Calibrated against a real app
 * rather than round numbers: `app-draw` is 9.8 MB extracted, 2.7 MB zipped,
 * almost all of it one `gui.js` carrying a bundled Excalidraw.
 */
const TOTAL_MAX = 50 * 1024 * 1024
const FILE_MAX = 20 * 1024 * 1024
const FILES_MAX = 500

/**
 * The reducer, capped far lower and separately. It is the only file that becomes
 * executable Worker code; `gui.js` is an inert static asset however large it
 * gets. For reference `app-draw`'s reducer is 7.7 KB.
 */
const APP_MAX = 1024 * 1024

/**
 * The compressed archive, which is a MEMORY bound rather than a policy one —
 * kb/catalog.md caps extracted bytes on purpose, because compressed size bounds
 * nothing an attacker cares about. It exists because a ZIP is indexed from its
 * tail, so the archive cannot be streamed past.
 */
const ARCHIVE_MAX = 20 * 1024 * 1024

/** One stalled response must not eat the wall clock every other app is sharing. */
const TIMEOUT = 60_000

/** Where a bundle may start. kb/catalog.md#rules-deleted-by-discovery. */
const ROOTS = ['', 'dist/', 'build/', 'src/']

/** `.env*`, `.npmrc`, `id_rsa*`, `*.pem`, `*.key` — never rehosted. */
const SECRET = /^\.env|^\.npmrc$|^id_rsa|\.(pem|key)$/

/**
 * The bundle's own metadata file. It is CONTROL metadata, not payload: the
 * importer validates it and projects its known fields into the canonical
 * manifest, so its exact bytes stay in `bundle.zip` and are never rehosted under
 * `files/`. Two documents called `manifest.json` meaning different things is
 * precisely what that split avoids — what we serve at
 * `/v/{version}/manifest.json` is ours, generated, and authoritative.
 */
const AUTHORED = 'manifest.json'

/**
 * Fetch, validate and extract one resolved release, then record it.
 *
 * Its own module because it is its own phase: kb/registry.md keeps detection and
 * fetching apart so that moving this onto a Queue consumer — one binding, its
 * own 15-minute wall clock, retries and backoff — stays a change to `refresh()`
 * and nothing else.
 *
 * **The write order is load-bearing.** Payload, then the manifest, then the
 * record — nothing is reachable until the last one, and a crash before it leaves
 * bytes that the GC sweep is designed to find rather than a release whose
 * manifest does not exist. Failure is recorded on the app and retried next run;
 * it never throws at the caller, because one hostile archive must not stop the
 * others.
 */
export async function importRelease(
	env: CloudflareBindings,
	id: string,
	repo: string,
	resolved: Resolved
): Promise<void> {
	const record = await readRecord(env, id)
	const prefix = `apps/${id}/${resolved.version}`

	try {
		// A version is frozen once written. `refreshApp` already filters these out;
		// this is the guard for two runs overlapping, which nothing else prevents.
		if (record?.releases[resolved.version]) return

		const bytes = await download(env, repo, resolved)
		const all = entries(bytes)
		const root = bundleRoot(all)

		// The authored manifest first, because it names the reducer — and the reducer
		// is the one file whose cap differs, so nothing else can be read until it is
		// known.
		const authored = await readAuthored(bytes, all, root)
		if (authored.id && authored.id !== id) console.warn(`${id}: manifest claims id ${authored.id}`)

		// Two collections, because they answer different questions. `files` is the
		// payload we serve and a device mounts; `digests` also carries the authored
		// manifest, so the whole-app hash still moves when metadata alone changes.
		const files: CatalogFile[] = []
		const digests: Record<string, string> = {}
		let unpacked = 0

		for (const entry of all) {
			if (entry.name.endsWith('/') || !entry.name.startsWith(root)) continue
			const path = bundlePath(entry, root)

			// Case-insensitively, because two entries differing only by case resolve
			// to one file on a case-folding filesystem — so which of them a device
			// ends up with would depend on the device.
			if (digests[path] || Object.keys(digests).some((p) => p.toLowerCase() === path.toLowerCase()))
				throw new Error(`${path}: duplicate`)
			if (Object.keys(digests).length >= FILES_MAX) throw new Error(`over ${FILES_MAX} files`)
			if (unpacked >= TOTAL_MAX) throw new Error(`over ${TOTAL_MAX} bytes extracted`)

			// The remaining total is part of the cap, so no single entry can spend a
			// budget the ones before it already used.
			const cap = Math.min(path === authored.app ? APP_MAX : FILE_MAX, TOTAL_MAX - unpacked)
			const file = await inflate(bytes, entry, cap)
			unpacked += file.byteLength

			const hash = `sha256-${await sha256(file)}`
			digests[path] = hash
			if (path === AUTHORED) continue

			// `size` is what came out of the inflate, never what the archive declared:
			// it is what bounds a client's read before the hash can be checked, so a
			// number the bundle chose would be a number an attacker chose.
			files.push({ path, hash, size: file.byteLength })
			await env.STORE.put(`${prefix}/files/${path}`, file)
		}

		if (!files.some((file) => file.path === authored.app))
			throw new Error(`manifest names ${authored.app}, which is not here`)

		const manifest = releaseManifest(authored, {
			id,
			version: resolved.version,
			hash: await appHash(Object.entries(digests).map(([path, hash]) => ({ path, hash }))),
			files
		})

		await env.STORE.put(`${prefix}/bundle.zip`, bytes)
		// One level above `files/`, so the document we generate can never be shadowed
		// by a payload file of the same name.
		await env.STORE.put(`${prefix}/manifest.json`, JSON.stringify(manifest), {
			httpMetadata: { contentType: 'application/json' }
		})

		const release: Release = {
			...resolved,
			bundle: { digest: `sha256-${await sha256(bytes)}`, size: bytes.byteLength, unpacked },
			state: 'ready',
			at: Math.floor(Date.now() / 1000)
		}
		await writeRecord(env, id, {
			...blank(),
			...record,
			error: null,
			releases: { ...record?.releases, [resolved.version]: release },
			// The catalog PR is the approval; every imported release goes live as it lands.
			current: resolved.version
		})
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err)
		console.error(`import ${id} ${resolved.version}:`, error)
		// Recorded rather than thrown, and retried next run — the resolution is not
		// remembered, so a fixed release is picked up without anything to reset.
		if (record) await writeRecord(env, id, { ...record, error })
	}
}

/**
 * The archive, buffered whole because a ZIP is indexed from its tail.
 *
 * Both sources redirect to a storage host that rejects a second credential, so
 * the Authorization header must not survive the hop — `fetch` strips it across
 * origins per the Fetch standard, which is why this must not be hand-followed.
 */
async function download(
	env: CloudflareBindings,
	repo: string,
	resolved: Resolved
): Promise<Uint8Array> {
	const path =
		resolved.assetId === undefined
			? `/repos/${repo}/zipball/${resolved.commit}`
			: `/repos/${repo}/releases/assets/${resolved.assetId}`

	const res = await archive(env, path, AbortSignal.timeout(TIMEOUT))
	if (!res.ok || !res.body) throw new Error(`archive: ${res.status}`)
	return readCapped(res.body, ARCHIVE_MAX, 'archive')
}

/**
 * Where the bundle starts inside the archive.
 *
 * A repository zipball wraps everything in one generated directory
 * (`justfiles-app-draw-a3f9c21/`), so that is stripped first. Searching the
 * roots rather than requiring a declaration is what deletes a rule the author
 * can get wrong — see kb/catalog.md#rules-deleted-by-discovery.
 */
function bundleRoot(all: ZipEntry[]): string {
	const names = all.map((e) => e.name)
	const [first = ''] = (names[0] ?? '').split('/')
	const wrapper = first && names.every((n) => n.startsWith(`${first}/`)) ? `${first}/` : ''

	const has = new Set(names)
	for (const dir of ROOTS) if (has.has(`${wrapper}${dir}${AUTHORED}`)) return `${wrapper}${dir}`
	throw new Error(`no ${AUTHORED} in ${ROOTS.map((r) => `${wrapper}${r || './'}`).join(', ')}`)
}

async function readAuthored(
	bytes: Uint8Array,
	all: ZipEntry[],
	root: string
): Promise<AppManifest> {
	// `bundleRoot` resolved against this exact name, so it is present.
	const entry = all.find((e) => e.name === `${root}${AUTHORED}`)
	if (!entry) throw new Error(`no ${AUTHORED}`)

	const raw = new TextDecoder().decode(await inflate(bytes, entry, APP_MAX))
	const manifest = JSON.parse(raw) as AppManifest
	if (!manifest.app) throw new Error('manifest declares no app entry point')
	if (!manifest.name) throw new Error('manifest declares no name')
	return manifest
}

/**
 * One entry's path inside the bundle, or a throw. Everything an archive can lie
 * about is refused here rather than quietly filtered, so a hostile bundle fails
 * the import instead of being partially accepted.
 */
function bundlePath(entry: ZipEntry, root: string): string {
	// S_IFLNK. A symlink's content is its target, so extracting one either escapes
	// the prefix or gives a second name to a file that was checked once.
	if ((entry.mode & 0xf000) === 0xa000) throw new Error(`${entry.name}: symlink`)
	// `\` separates paths on Windows, so a name carrying one reaches a different
	// file there than the one validated here.
	if (entry.name.includes('\\')) throw new Error(`${entry.name}: backslash`)

	// Rejects absolute paths, `..` traversal, NUL, and empty names.
	const path = safeBundlePath(entry.name.slice(root.length))

	// Only under the bundle root, because that is the only part that gets rehosted
	// at a public URL. A `.env.example` sitting beside a repository's source is
	// not this project's problem, and hard-failing on one would reject the
	// repository-tree rungs almost everywhere.
	if (SECRET.test(path.slice(path.lastIndexOf('/') + 1)))
		throw new Error(`${path}: refusing to rehost`)
	return path
}

const sha256 = async (bytes: Uint8Array) =>
	[...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')

/** Only reached if an import somehow runs before the poll that creates the app. */
const blank = (): AppRecord => ({
	repoNodeId: '',
	defaultBranch: '',
	current: null,
	etags: {},
	checkedAt: 0,
	error: null,
	releases: {}
})
