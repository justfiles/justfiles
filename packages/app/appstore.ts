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
import type { AppManifest } from './app.ts'
import { isHosted } from './app.ts'
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
			if (action === 'skip') continue
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
	// Structural migration: an app installed as copied bytes that the store now serves
	// from an origin has to be reinstalled to become a spec, and the trigger cannot be
	// the version — a release that only changes PACKAGING leaves version and hash
	// untouched, and every other signal here would say 'skip' forever. Checked before
	// them so it does not depend on anyone remembering to bump.
	if (installed && !isHosted(installed) && app.baseUrl) return gte ? 'repair' : 'skip'
	if (!(await filesPresentAndMatch(fs, app, installed))) return gte ? 'repair' : 'skip'
	if (installed?.hash === (await appHash(app))) return 'skip'
	return gte ? 'upgrade' : 'skip'
}

// Install `app` from the store. Two shapes, decided by whether the store can re-serve
// the app's files:
//
//   hosted — write the SPEC and stop. The manifest records `baseUrl`, the whole-app
//            hash and every file's pinned hash, which is everything a device needs to
//            fetch, verify and run the app later. One request instead of N, and the
//            payload never enters the volume, so nothing about it replicates.
//   local  — download every file, verifying each pinned hash before it lands, and copy
//            the lot in. The only correct shape when there is no origin to refetch
//            from. Files download through a bounded worker pool (not one-at-a-time),
//            so a many-file app installs in a fraction of the wall-clock time — first
//            byte to installed shrinks, cutting the window where a closed tab /
//            dropped connection abandons the install.
//
// The on-demand install entry point (first-time install of a store app) and the path
// `materialise`/`reconcile` use internally.
const INSTALL_CONCURRENCY = 12

export async function installApp(kernel: Kernel, store: AppStore, app: CatalogApp): Promise<void> {
	const declared = await appManifest(store, app)
	const spec: AppManifest = {
		...declared,
		id: app.id,
		version: app.version,
		hash: await appHash(app),
		// Where an app's bytes come from is the STORE's fact, never the bundle's claim —
		// a published manifest that named its own origin would otherwise decide its own
		// residency, and point the mount wherever it liked.
		baseUrl: undefined,
		files: undefined
	}
	if (app.baseUrl) {
		await kernel.install(
			specBundle({
				...spec,
				baseUrl: app.baseUrl,
				files: Object.fromEntries(
					app.files
						.filter((file) => file.path !== 'manifest.json')
						.map((file) => [safeBundlePath(file.path), file.hash])
				)
			})
		)
		return
	}

	const files = new Map<string, Uint8Array>()
	const queue = app.files.filter((file) => file.path !== 'manifest.json')
	const fetchOne = async (): Promise<void> => {
		for (let file = queue.pop(); file; file = queue.pop()) {
			const bytes = await store.read(app, file.path)
			await verifyHash(app, file, bytes)
			files.set(safeBundlePath(file.path), bytes) // single-threaded: no Map race between awaits
		}
	}
	await Promise.all(Array.from({ length: Math.min(INSTALL_CONCURRENCY, queue.length) }, fetchOne))
	await kernel.install(bundleFromFiles(spec, files))
}

// The app's own declared metadata — entry paths, capabilities, description — read from
// the one catalog file that is always fetched even for a hosted install, because the
// record has to carry it.
async function appManifest(store: AppStore, app: CatalogApp): Promise<AppManifest> {
	const file = app.files.find((f) => f.path === 'manifest.json')
	if (!file) throw new Error(`catalog app missing manifest.json: ${app.id}`)
	const bytes = await store.read(app, 'manifest.json')
	await verifyHash(app, file, bytes)
	return JSON.parse(new TextDecoder().decode(bytes))
}

// Every catalog file is present locally with its pinned content (self-heal signal).
// Only meaningful for an app whose bytes are IN the volume: a hosted app keeps its
// payload in the cache, where a miss or a mismatch is repaired by the next read
// against the manifest's own hashes rather than by a reinstall.
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
	if (app.baseUrl || (installed && isHosted(installed))) return true
	for (const file of app.files) {
		if (file.path === 'manifest.json') continue
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

// A hosted install: the record IS the bundle. `kernel.install` writes `manifest.json`
// and nothing else, and the payload is mounted from `baseUrl` on first read.
function specBundle(manifest: AppManifest): AppBundle {
	return {
		async manifest() {
			return manifest
		},
		async *list() {},
		async read(path) {
			throw new Error(`hosted app has no local file: ${path}`)
		}
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
