// The app-store abstraction. An `AppStore` is addressed by app id and version:
// `builtins()` returns the small, bounded set this release ships, and
// `latest(id)` returns one app's newest entry. Nothing enumerates the whole
// store — a public catalog won't fit in one call, and its browse listing will be
// paginated later. Two entry points make a kernel's volume match the store:
// `materialise` installs any built-in that isn't present (first-run seeding),
// and `reconcile` updates the apps that ARE installed (built-in or not). They
// are split so a built-in the user deleted is NOT force-reinstalled by the
// update path — seeding is a deliberate, separate step. The store is
// host-supplied (HTTP assets, packaged FS bundles, future remote stores), so
// this layer is host-agnostic.

import type { Volume } from '@justfiles/fs'
import type { AppManifest, InstalledApp } from './app.ts'
import { type AppBundle, type CapabilityDecl, type Kernel, safeBundlePath } from './kernel.ts'

export interface CatalogFile {
	path: string
	hash: string
	size: number
}

export interface CatalogApp {
	id: string
	name: string
	version: string
	icon?: string
	// Declared capabilities (static, from the manifest). Drives the consent sheet
	// and the update-time escalation guard.
	capabilities?: CapabilityDecl
	files: CatalogFile[]
	// A store-generated canonical manifest. Legacy stores leave this absent and
	// expose their authored manifest as one of `files` instead.
	manifest?: AppManifest
	// A store-generated whole-app fingerprint. Legacy stores derive it from
	// `files`; registries may include control metadata they deliberately do not
	// rehost, so their canonical value cannot be reconstructed by the client.
	hash?: string
	// Where this version's files are served from, version-pinned and immutable. Set by
	// a store that can re-serve its apps on demand (frieren's `/appstore` assets); a
	// store whose bytes have no stable address (a packaged FS bundle) leaves it unset
	// and its apps are copied into the volume instead. This single field is what
	// decides an installed app's shape — see `AppManifest`.
	baseUrl?: string
}

export interface Catalog {
	schema: string
	apps: CatalogApp[]
}

// The app store. Every query is per-app or the bounded built-in set — there is
// deliberately no "return all apps" call, because the public catalog will be
// large and its browse listing paginated (a future `list(cursor)`, not on the
// update path). Built-ins co-ship with the release, so returning that whole set
// is cheap and correct.
export interface AppStore {
	// The built-in apps this release ships (NOT the whole store). Boot reconciles
	// against it: installs any missing, updates any changed.
	builtins(): Promise<CatalogApp[]>
	// The latest published entry for one app, or null if the store no longer carries
	// it. Per-app so an installed app can check itself and boot can walk the
	// installed set one id at a time — never enumerating the store.
	latest(id: string): Promise<CatalogApp | null>
	// Read one file's bytes for a specific app version.
	read(app: CatalogApp, path: string): Promise<Uint8Array>
}

// Ensure the built-in set is present: install every built-in that isn't already
// installed. The ONLY path that installs a missing built-in — `reconcile` never
// does (it only updates what's installed). Idempotent, so callers run it to keep
// the built-ins present: each boot (a newly-shipped built-in then lands for
// existing volumes, not just empty ones) or once on first run.
export async function materialise(kernel: Kernel, store: AppStore): Promise<void> {
	const installed = new Set((await kernel.list()).map((m) => m.id))
	for (const app of await store.builtins()) {
		if (!installed.has(app.id)) await installApp(kernel, store, app)
	}
}

// Update the apps that are INSTALLED against the store — never installs a missing
// one. One pass over the installed set: a built-in resolves to this release's
// catalog entry, any other app to the store's `latest(id)` (queried one id at a
// time — the store is never enumerated). `decide` chooses repair/upgrade/skip;
// reinstall is atomic (`kernel.install`) and idempotent, so launch/sweep/watcher
// triggers can all run freely. Each app is isolated: a store that can't serve one
// app (CDN down, tampered bytes, unreachable catalog) must not stop the rest of
// the set from updating. A failure is left for the caller's next checkpoint to
// retry — no retry queue, because installs are atomic (the app keeps working on
// its current version) and the periodic check IS the retry.
export async function reconcile(kernel: Kernel, fs: Volume, store: AppStore): Promise<void> {
	const installed = (await kernel.list()).map((m) => m.id)
	const builtins = await store.builtins()
	const builtinById = new Map(builtins.map((app) => [app.id, app]))
	for (const id of installed) {
		try {
			const app = builtinById.get(id) ?? (await store.latest(id))
			if (!app) continue
			const action = await decide(fs, app)
			// An app that reached this device through sync never ran an install here, so
			// this is where its mounted files get prefetched into the host cache. Swallowed
			// for the same reason the one after an install is: this app is NOT being
			// updated, so a cache that stayed cold is not an update failure and must not
			// be logged as one on every pass.
			if (action === 'skip') {
				if (app.baseUrl) await prefetchApp(kernel, id).catch(() => {})
				continue
			}
			// Escalation guard: a non-builtin (re)install that declares more capabilities
			// than the installed version is held (skipped) so re-consent can land first
			// (Step 5). `escalates` is true only on real capability growth, so a same-
			// version self-heal (caps unchanged) still proceeds. Built-ins are trusted.
			if (!builtinById.has(id) && (await escalates(fs, app))) continue
			await installApp(kernel, store, app)
		} catch (e) {
			console.warn(`appstore: update failed for ${id}`, e)
		}
	}
}

// What reconcile should do for one INSTALLED app. Split "repair" from "upgrade"
// so a missing/corrupt file is self-healed even when the whole-app hash matches,
// while a version change stays governed by the monotonic guard. Both are
// monotonic: `skip` when the store is older than what's installed, so a stale
// client build can never downgrade a newer app (repair included).
type SyncAction = 'skip' | 'repair' | 'upgrade'

async function decide(fs: Volume, app: CatalogApp): Promise<SyncAction> {
	const installed = await installedManifest(fs, app.id)
	const gte = semverGte(app.version, installed?.version ?? '0.0.0')
	// The record has to name the source the store CURRENTLY serves from. The whole-app
	// hash covers file paths and digests only, so a release that just MOVES — copied to
	// hosted, hosted to copied, or one origin to another — leaves it unchanged, and
	// every other signal below would say 'skip' forever: the record would stay pointed
	// at a source that no longer serves it, with nothing to notice. Checked first so
	// the migration off the copied layout does not depend on a version bump either.
	if (installed && installed.baseUrl !== app.baseUrl) return gte ? 'repair' : 'skip'
	if (!(await filesPresentAndMatch(fs, app, installed))) return gte ? 'repair' : 'skip'
	if (installed?.hash === (app.hash ?? (await appHash(app)))) return 'skip'
	return gte ? 'upgrade' : 'skip'
}

// Install `app` from the store. What lands in the volume depends on whether the store
// can re-serve the app's files:
//
//   hosted — the SPEC plus the reducer. The manifest records `baseUrl`, the whole-app
//            hash and each MOUNTED file's pinned hash, which is everything a device
//            needs to fetch and verify the rest later. Two requests instead of N, and
//            the GUI and assets never enter the volume, so they never replicate.
//   local  — download every file, verifying each pinned hash before it lands, and copy
//            the lot in. The only correct shape when there is no origin to refetch
//            from.
//
// Files download through a bounded worker pool (not one-at-a-time), so a many-file app
// installs in a fraction of the wall-clock time — first byte to installed shrinks,
// cutting the window where a closed tab / dropped connection abandons the install.
//
// The on-demand install entry point (first-time install of a store app) and the path
// `materialise`/`reconcile` use internally.
const INSTALL_CONCURRENCY = 12
const installing = new WeakMap<Kernel, Map<string, Promise<void>>>()

export async function installApp(kernel: Kernel, store: AppStore, app: CatalogApp): Promise<void> {
	let byId = installing.get(kernel)
	if (!byId) {
		byId = new Map()
		installing.set(kernel, byId)
	}
	const active = byId.get(app.id)
	if (active) return active
	const task = performInstall(kernel, store, app).finally(() => byId.delete(app.id))
	byId.set(app.id, task)
	return task
}

async function performInstall(kernel: Kernel, store: AppStore, app: CatalogApp): Promise<void> {
	const declared = await appManifest(store, app)
	const reducer = safeBundlePath(declared.app)
	const spec: AppManifest = {
		...declared,
		id: app.id,
		version: app.version,
		hash: app.hash ?? (await appHash(app)),
		// Where an app's bytes come from is the STORE's fact, never the bundle's claim —
		// a published manifest that named its own origin would otherwise decide its own
		// residency, and point the mount wherever it liked.
		baseUrl: app.baseUrl,
		// Only what actually mounts. The reducer is downloaded now and stored in the
		// volume, so pinning it here would describe a fetch that never happens.
		files: app.baseUrl
			? Object.fromEntries(
					app.files
						.filter((file) => file.path !== 'manifest.json')
						.map((file) => [safeBundlePath(file.path), file.hash] as const)
						.filter(([path]) => path !== reducer)
				)
			: undefined
	}

	// A hosted install copies in the reducer alone; a local one copies everything.
	const files = new Map<string, Uint8Array>()
	const queue = app.files.filter(
		(file) =>
			file.path !== 'manifest.json' && (!app.baseUrl || safeBundlePath(file.path) === reducer)
	)
	const fetchOne = async (): Promise<void> => {
		for (let file = queue.pop(); file; file = queue.pop()) {
			const bytes = await store.read(app, file.path)
			await verifyHash(app, file, bytes)
			files.set(safeBundlePath(file.path), bytes) // single-threaded: no Map race between awaits
		}
	}
	await Promise.all(Array.from({ length: Math.min(INSTALL_CONCURRENCY, queue.length) }, fetchOne))
	if (app.baseUrl && !files.has(reducer)) {
		throw new Error(`catalog app missing its reducer: ${app.id}/${reducer}`)
	}
	await kernel.install(bundleFromFiles(spec, files))
	// Past the commit point, so nothing here can be allowed to reject: the record and
	// the reducer are live, and a caller that saw a rejection would report a failed
	// install of a working app — `materialise` would stop before the rest of the
	// built-ins, and a direct store install would report failure. The per-file
	// swallow inside is not enough on its own; resolving the app back out of the
	// volume is a read too, and it happens after the same commit.
	if (app.baseUrl) await prefetchApp(kernel, app.id).catch(() => {})
}

/**
 * Warm the cache with everything a hosted app mounts, so it runs offline.
 *
 * Fast-follow, not part of the install: the record and the reducer are already
 * in the volume when this starts, so an interrupted prefetch leaves a working
 * app with a cold cache rather than a half-installed one — which is why a
 * failure here is swallowed. The files still mount on demand, exactly as before.
 *
 * Without it "installed" means only that the app can run WITH a network. The
 * reducer is in the volume but the GUI is not, so a device that installs an app
 * and goes offline has everything except the half it can see.
 *
 * It reads through `mount()` — fetch and verify against the pin — so the host's
 * fetch layer fills exactly the entries a later read requests.
 */
async function prefetchApp(kernel: Kernel, appId: string): Promise<void> {
	const installed = await kernel.app(appId)
	await warm(installed, Object.keys(installed.manifest.files ?? {}))
}

/**
 * The same warming, for an app that never installed on THIS device.
 *
 * A hosted app arrives through sync fully formed — another device installed it,
 * and the record and reducer replicated here — so no install ran locally and
 * nothing filled the cache. `decide` is right to skip it (the volume does match
 * the catalog; the mounted half is a cache, not part of the install), which
 * leaves reconcile as the only pass that can notice, and multi-device is the
 * ordinary way a second device gets an app.
 *
 * Reads still go through the host cache, so an already-cached immutable release
 * does not move its payload again.
 */
async function warm(installed: InstalledApp, queue: string[]): Promise<void> {
	const readOne = async (): Promise<void> => {
		// Swallowed per file: being offline, or reaching an origin that is not serving
		// this release yet, leaves a cold cache rather than a broken app — the file
		// mounts on demand later exactly as it did before. Both callers swallow the
		// whole pass as well, because both run after the app is already usable.
		for (let path = queue.pop(); path; path = queue.pop())
			await installed.read(path).catch(() => {})
	}
	await Promise.all(Array.from({ length: Math.min(INSTALL_CONCURRENCY, queue.length) }, readOne))
}

// The app's own declared metadata — entry paths, capabilities, description — read from
// the one catalog file that is always fetched even for a hosted install, because the
// record has to carry it.
async function appManifest(store: AppStore, app: CatalogApp): Promise<AppManifest> {
	if (app.manifest) return app.manifest
	const file = app.files.find((f) => f.path === 'manifest.json')
	if (!file) throw new Error(`catalog app missing manifest.json: ${app.id}`)
	const bytes = await store.read(app, 'manifest.json')
	await verifyHash(app, file, bytes)
	return JSON.parse(new TextDecoder().decode(bytes))
}

// Every catalog file that belongs in the VOLUME is present with its pinned content
// (self-heal signal). For a hosted app that is the reducer alone — the mounted half is
// a cache, where a miss or a mismatch is repaired by the next read against the record's
// own hashes rather than by a reinstall.
//
// Excludes manifest.json — the kernel re-serialises it on install (normalised entry
// paths, plus the spec fields), so its installed bytes never match the catalog's
// verbatim copy; the whole-app hash / version read cover manifest changes instead. A
// missing file (partial install / un-hydrated stub) or a content mismatch (corruption)
// returns false so `decide` repairs it.
async function filesPresentAndMatch(
	fs: Volume,
	app: CatalogApp,
	installed: AppManifest | null
): Promise<boolean> {
	const reducer = safeBundlePath(installed?.app ?? 'app.js')
	for (const file of app.files) {
		if (file.path === 'manifest.json') continue
		if (app.baseUrl && safeBundlePath(file.path) !== reducer) continue
		let contentHash: string | undefined
		try {
			const stat = await fs.stat(`/applications/${app.id}/${safeBundlePath(file.path)}`)
			contentHash = stat.contentHash
		} catch {
			return false // missing locally → (re)install
		}
		if (`sha256-${contentHash ?? ''}` !== file.hash) return false
	}
	return true
}

// The installed app's manifest, or null when it is missing/corrupt. One read for every
// question `decide` asks of it — declared version, shape, whole-app hash, capabilities.
async function installedManifest(fs: Volume, id: string): Promise<AppManifest | null> {
	try {
		const bytes = await fs.readFile(`/applications/${id}/manifest.json`)
		return JSON.parse(new TextDecoder().decode(bytes))
	} catch {
		return null
	}
}

// `a >= b` over dot-separated numeric versions (leading integer of each
// segment; missing segments = 0). Deliberately simple — built-ins use plain
// semver; pre-release/build suffixes are ignored, which is safe for the
// no-downgrade guard (it only ever needs a coarse ordering).
export function semverGte(a: string, b: string): boolean {
	const parse = (v: string) => v.split('.').map((s) => Number.parseInt(s, 10) || 0)
	const as = parse(a)
	const bs = parse(b)
	const len = Math.max(as.length, bs.length)
	for (let i = 0; i < len; i++) {
		const d = (as[i] ?? 0) - (bs[i] ?? 0)
		if (d !== 0) return d > 0
	}
	return true
}

// Capability tokens: the capability `id`, plus each scope as `id::scope`. Growth
// is the unit the escalation guard measures.
function capabilityTokens(caps: CapabilityDecl | undefined): Set<string> {
	const tokens = new Set<string>()
	for (const { id, scopes } of Object.values(caps ?? {})) {
		tokens.add(id)
		for (const scope of scopes) tokens.add(`${id}::${scope}`)
	}
	return tokens
}

// Does `next` declare MORE than `installed` — a new capability id or a broader
// scope? Subset/equal returns false (auto-update is safe); any new token is an
// escalation that must be re-consented before it applies.
export function escalatesCapabilities(
	installed: CapabilityDecl | undefined,
	next: CapabilityDecl | undefined
): boolean {
	const have = capabilityTokens(installed)
	for (const token of capabilityTokens(next)) if (!have.has(token)) return true
	return false
}

async function escalates(fs: Volume, app: CatalogApp): Promise<boolean> {
	const installed = await installedManifest(fs, app.id)
	return escalatesCapabilities(installed?.capabilities, app.capabilities)
}

// The whole-app hash: one sha256 folding every file's pinned hash together
// (paths sorted, so it's independent of catalog order). Because manifest.json is
// itself a hashed file, this covers ALL of an app's metadata — version, name,
// icon, declared capabilities — alongside its code and assets, and it moves when
// any file is added or removed. It is the single signal the update path
// compares: a manifest-only edit that never touches the version still changes
// the digest (so it reinstalls), and an unchanged app never does.
async function appHash(app: CatalogApp): Promise<string> {
	const input = [...app.files]
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		.map((file) => `${file.path}\u0000${file.hash}`)
		.join('\n')
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Integrity check: the catalog pins each file's `sha256-<hex>` digest (emitted
// by the build over the exact served bytes). Verify before installing so
// corrupt or tampered bytes never reach the volume.
async function verifyHash(app: CatalogApp, file: CatalogFile, bytes: Uint8Array): Promise<void> {
	const expected = file.hash.replace(/^sha256-/, '')
	const buffer = bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength
	) as ArrayBuffer
	const digest = await crypto.subtle.digest('SHA-256', buffer)
	const actual = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
	if (actual !== expected) {
		throw new Error(`builtins: ${app.id}/${file.path} hash mismatch`)
	}
}

function bundleFromFiles(manifest: AppManifest, files: Map<string, Uint8Array>): AppBundle {
	return {
		async manifest() {
			return manifest
		},
		async *list() {
			yield* files.keys()
		},
		async read(path) {
			const bytes = files.get(safeBundlePath(path))
			if (!bytes) throw new Error(`file not found: ${path}`)
			return bytes
		}
	}
}
