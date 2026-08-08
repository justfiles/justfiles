import { type AppManifest, safeBundlePath } from '@justfiles/app'
import type { CatalogFile } from '@justfiles/app/appstore'
import { archive } from './github'
import { type Info, type Release, type Resolved, readInfo, writeInfo } from './refresh-app'
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
 * Fetch, validate and extract one resolved release, then record it.
 *
 * Its own module because it is its own phase: kb/registry.md keeps detection and
 * fetching apart so that moving this onto a Queue consumer — one binding, its
 * own 15-minute wall clock, retries and backoff — stays a change to `refresh()`
 * and nothing else.
 *
 * **The write order is load-bearing.** Files, then `spec.json`, then `info.json`
 * — nothing is reachable until the last one, and a crash before it leaves bytes
 * that the GC sweep is designed to find rather than a release whose spec does
 * not exist. Failure is recorded on the app and retried next run; it never
 * throws at the caller, because one hostile archive must not stop the others.
 */
export async function importRelease(
	env: CloudflareBindings,
	id: string,
	repo: string,
	resolved: Resolved
): Promise<void> {
	const info = await readInfo(env, id)
	const prefix = `apps/${id}/${resolved.version}`

	try {
		// A version is frozen once written. `refreshApp` already filters these out;
		// this is the guard for two runs overlapping, which nothing else prevents.
		if (info?.releases[resolved.version]) return

		const bytes = await download(env, repo, resolved)
		const all = entries(bytes)
		const root = bundleRoot(all)

		// The manifest first, because it names the reducer — and the reducer is the
		// one file whose cap differs, so nothing else can be read until it is known.
		const manifest = await readManifest(bytes, all, root)
		if (manifest.id && manifest.id !== id) console.warn(`${id}: manifest claims id ${manifest.id}`)

		const digests: Record<string, string> = {}
		const sizes: Record<string, number> = {}
		let total = 0

		for (const entry of all) {
			if (entry.name.endsWith('/') || !entry.name.startsWith(root)) continue
			const path = bundlePath(entry, root)

			// Case-insensitively, because two entries differing only by case resolve
			// to one file on a case-folding filesystem — so which of them a device
			// ends up with would depend on the device.
			if (digests[path] || Object.keys(digests).some((p) => p.toLowerCase() === path.toLowerCase()))
				throw new Error(`${path}: duplicate`)
			if (Object.keys(digests).length >= FILES_MAX) throw new Error(`over ${FILES_MAX} files`)
			if (total >= TOTAL_MAX) throw new Error(`over ${TOTAL_MAX} bytes extracted`)

			// The remaining total is part of the cap, so no single entry can spend a
			// budget the ones before it already used.
			const cap = Math.min(path === manifest.app ? APP_MAX : FILE_MAX, TOTAL_MAX - total)
			const file = await inflate(bytes, entry, cap)
			total += file.byteLength

			digests[path] = `sha256-${await sha256(file)}`
			sizes[path] = file.byteLength
			await env.STORE.put(`${prefix}/files/${path}`, file)
		}

		if (!digests[manifest.app]) throw new Error(`manifest names ${manifest.app}, which is not here`)

		const spec: AppManifest = {
			...manifest,
			// Ours, never the manifest's. An app claiming another id would otherwise
			// be served — and trusted — under a name it does not own.
			id,
			// The tag is the immutable thing, so it wins where the two disagree.
			version: resolved.version,
			hash: await appHash(digests),
			// The mounted half only. The reducer is durable on the device and never
			// mounted, so an installed app keeps working after this release stops
			// being served; `hash` above still covers it.
			files: Object.fromEntries(Object.entries(digests).filter(([p]) => p !== manifest.app))
		}

		// **`baseUrl` is deliberately absent**, and the serving route injects it. It
		// is the only place an app id would appear in stored release data, so
		// keeping it out is what makes a future rename a prefix move rather than a
		// rewrite of every spec we hold — see kb/registry.md#renames-are-deferred.
		// A device reading this file unmodified would treat the app as unhosted.
		await env.STORE.put(`${prefix}/bundle.zip`, bytes)

		// The catalog's view of the same release, and the one document that
		// describes EVERY file. `spec.json` above is an `AppManifest` and pins only
		// the mounted half, so the reducer's digest is deliberately missing from it
		// — but a store has to hand that digest out, because a device downloads the
		// reducer into its volume and verifies it before it runs. Sizes live here
		// for the same reason: they are a catalog fact, not a manifest one.
		//
		// Written before `spec.json` so it obeys the same rule as everything else
		// here: `info.json` is the last write, and nothing a reader can reach
		// through it may be missing by the time it lands.
		await env.STORE.put(`${prefix}/files.json`, JSON.stringify(catalogFiles(digests, sizes)), {
			httpMetadata: { contentType: 'application/json' }
		})
		await env.STORE.put(`${prefix}/spec.json`, JSON.stringify(spec), {
			httpMetadata: { contentType: 'application/json' }
		})

		const release: Release = {
			...resolved,
			digest: `sha256-${await sha256(bytes)}`,
			hash: spec.hash as string,
			bytes: total,
			state: 'ready',
			at: Math.floor(Date.now() / 1000)
		}
		await writeInfo(env, id, {
			...blank(),
			...info,
			error: null,
			releases: { ...info?.releases, [resolved.version]: release },
			// The catalog PR is the approval; every imported release goes live as it lands.
			current: resolved.version
		})
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err)
		console.error(`import ${id} ${resolved.version}:`, error)
		// Recorded rather than thrown, and retried next run — the resolution is not
		// remembered, so a fixed release is picked up without anything to reset.
		if (info) await writeInfo(env, id, { ...info, error })
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
	for (const dir of ROOTS) if (has.has(`${wrapper}${dir}manifest.json`)) return `${wrapper}${dir}`
	throw new Error(`no manifest.json in ${ROOTS.map((r) => `${wrapper}${r || './'}`).join(', ')}`)
}

async function readManifest(
	bytes: Uint8Array,
	all: ZipEntry[],
	root: string
): Promise<AppManifest> {
	// `bundleRoot` resolved against this exact name, so it is present.
	const entry = all.find((e) => e.name === `${root}manifest.json`)
	if (!entry) throw new Error('no manifest.json')

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

/**
 * Every file of the release, as a store hands them out. Sorted by path so the
 * document is stable across imports of the same bytes, and typed as the
 * consumer's own `CatalogFile` so the two shapes cannot drift apart.
 */
function catalogFiles(
	digests: Record<string, string>,
	sizes: Record<string, number>
): CatalogFile[] {
	return Object.entries(digests)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([path, hash]) => ({ path, hash, size: sizes[path] as number }))
}

/**
 * The whole-app fingerprint, matching `appstore.ts`'s `appHash` exactly —
 * a device compares this string to decide whether an installed app is still the
 * published one, so the two have to agree byte for byte. Sorted by path, so it
 * is independent of archive order, and over EVERY file, so a manifest-only edit
 * that never touches the version still moves it.
 */
async function appHash(digests: Record<string, string>): Promise<string> {
	const input = Object.entries(digests)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([path, hash]) => `${path}\u0000${hash}`)
		.join('\n')
	return sha256(new TextEncoder().encode(input))
}

const sha256 = async (bytes: Uint8Array) =>
	[...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')

/** Only reached if an import somehow runs before the poll that creates the app. */
const blank = (): Info => ({
	repoNodeId: '',
	defaultBranch: '',
	current: null,
	etags: {},
	checkedAt: 0,
	error: null,
	releases: {}
})
