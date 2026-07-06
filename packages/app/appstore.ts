// The app-store abstraction. An `AppStore` is addressed by app id and version:
// `builtins()` returns the small, bounded set this release ships, and
// `latest(id)` returns one app's newest entry. Nothing enumerates the whole
// store — a public catalog won't fit in one call, and its browse listing will be
// paginated later. `reconcile` makes a kernel's volume match the store: it
// installs any missing built-in (a new built-in from a major release lands on an
// existing volume, and a built-in a user deleted comes back next launch) and
// updates changed apps. The store is host-supplied (HTTP assets, packaged FS
// bundles, future remote stores), so this layer is host-agnostic.

import type { Volume } from '@justfiles/fs'
import { type AppBundle, type Kernel, safeBundlePath } from './kernel.ts'

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
	files: CatalogFile[]
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

// The marker file `sync` writes into each installed bundle recording the
// whole-app hash of the release it came from. Boot compares it against the hash
// the catalog currently yields to decide whether to reinstall. A dotfile so it
// stays off every bundle-listing surface (see `hidden` in kernel.ts).
const INSTALL_HASH_PATH = '.apphash'

// Reconcile a volume against a store on boot. Two passes, neither enumerating the
// store: (1) every built-in this release ships is installed and current — so a
// new built-in from a major release lands on an existing volume; (2) every other
// installed app is updated to the store's `latest`, queried one id at a time (the
// same check an app runs on itself at launch). Change is decided by the
// whole-app hash (`appHash`) and reinstall is atomic (`kernel.install`).
// Built-ins always reinstall when missing — users can't permanently uninstall them.
export async function reconcile(kernel: Kernel, fs: Volume, store: AppStore): Promise<void> {
	const installed = new Set((await kernel.list()).map((m) => m.id))
	const builtins = await store.builtins()
	const builtinIds = new Set(builtins.map((app) => app.id))
	for (const app of builtins) await sync(kernel, fs, store, app, installed.has(app.id))
	for (const id of installed) {
		if (builtinIds.has(id)) continue
		const app = await store.latest(id)
		if (app) await sync(kernel, fs, store, app, true)
	}
}

// Install `app` from the store unless the installed bundle already carries this
// release's whole-app hash. Verifies each file's pinned hash before it reaches
// the volume, then records the release's hash so the next boot can skip an
// unchanged app (and reinstall a changed one) with a single comparison.
async function sync(
	kernel: Kernel,
	fs: Volume,
	store: AppStore,
	app: CatalogApp,
	installed: boolean
): Promise<void> {
	const hash = await appHash(app)
	if (installed && (await installedHash(fs, app.id)) === hash) return
	const files = new Map<string, Uint8Array>()
	for (const file of app.files) {
		const bytes = await store.read(app, file.path)
		await verifyHash(app, file, bytes)
		files.set(safeBundlePath(file.path), bytes)
	}
	files.set(INSTALL_HASH_PATH, new TextEncoder().encode(hash))
	await kernel.install(bundleFromFiles(files))
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

// The whole-app hash recorded when this app was last installed (the marker
// `sync` writes). Null when absent — an app installed before this marker
// existed, or a partial/corrupt bundle — which forces a (re)install.
async function installedHash(fs: Volume, id: string): Promise<string | null> {
	try {
		const bytes = await fs.readFile(`/applications/${id}/${INSTALL_HASH_PATH}`)
		return new TextDecoder().decode(bytes)
	} catch {
		return null
	}
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

function bundleFromFiles(files: Map<string, Uint8Array>): AppBundle {
	return {
		async manifest() {
			const bytes = files.get('manifest.json')
			if (!bytes) throw new Error('catalog app missing manifest.json')
			return JSON.parse(new TextDecoder().decode(bytes))
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
