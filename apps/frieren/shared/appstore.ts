// The app store: built-in apps ship as static assets under `/appstore`, not
// bundled into the worker. A version-aware reconcile seeds them into a profile's
// volume on boot. Shared by three call sites so they can't diverge:
//   - build      (vite-appstore.ts) emits the assets + catalog
//   - server     (frieren.app.ts) reconciles the synced volume from `env.ASSETS`
//   - client     (src/apps/seed.ts) reconciles a local-only volume from `fetch`
//
// Who reconciles which volume: the server is the sole materializer for synced
// (signed-in) profiles — it owns the inos and pushes them down. The client only
// seeds local-only profiles, so the two never double-seed the same volume.

import { type AppBundle, type Kernel, safeBundlePath } from '@justfiles/app'
import type { Volume } from '@justfiles/fs'

export const CATALOG_SCHEMA = 'frieren/appstore-catalog/v1'
export const CATALOG_PATH = '/appstore/catalog.json'

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

// Version-pathed so a release is immutable and permanently cacheable.
export function appFileUrl(app: { id: string; version: string }, path: string): string {
	return `/appstore/apps/${app.id}/${app.version}/${path}`
}

// "Uninstalling" a built-in writes a disabled marker so a version bump can't
// resurrect it (Phase 4f writes these; reconcile only reads them).
export function disabledMarker(id: string): string {
	if (!/^[A-Za-z0-9]+([.-][A-Za-z0-9]+)*$/.test(id)) throw new Error(`invalid app id: ${id}`)
	return `/system/apps/disabled/${id}.json`
}

// Seed missing built-ins, reinstall the ones whose bytes changed, skip the rest,
// and never resurrect a disabled one. `read` fetches a file's bytes (server:
// env.ASSETS; client: fetch). Whether an app changed is decided by comparing the
// installed assets' stored `contentHash` to the catalog's pinned hash — so a
// caller that reconciles on every boot (dev re-materializes built-ins to pick up
// local edits) only reinstalls the apps you actually rebuilt, not all of them.
export async function reconcileBuiltins(
	kernel: Kernel,
	fs: Volume,
	catalog: Catalog,
	read: (app: CatalogApp, path: string) => Promise<Uint8Array>
): Promise<void> {
	const installed = new Set((await kernel.list()).map((m) => m.id))
	for (const app of catalog.apps) {
		if (await fs.exists(disabledMarker(app.id))) continue
		if (installed.has(app.id) && (await assetsMatch(fs, app))) continue
		const files = new Map<string, Uint8Array>()
		for (const file of app.files) {
			const bytes = await read(app, file.path)
			await verifyHash(app, file, bytes)
			files.set(safeBundlePath(file.path), bytes)
		}
		await kernel.install(bundleFromFiles(files))
	}
}

// True when every catalog asset is already installed with identical bytes,
// compared via the sha256 `contentHash` storage records on write. manifest.json
// is excluded: the kernel re-serialises it on install (normalised entry paths),
// so its installed bytes never match the catalog's verbatim copy — the other
// assets (app.js / gui.js / icon) fully capture whether the app changed.
async function assetsMatch(fs: Volume, app: CatalogApp): Promise<boolean> {
	for (const file of app.files) {
		if (file.path === 'manifest.json') continue
		let contentHash: string | undefined
		try {
			const stat = await fs.stat(`/applications/${app.id}/${safeBundlePath(file.path)}`)
			contentHash = stat.contentHash
		} catch {
			return false // asset missing locally → (re)install
		}
		if (`sha256-${contentHash ?? ''}` !== file.hash) return false
	}
	return true
}

// Integrity check: the catalog pins each file's `sha256-<hex>` digest (emitted
// by the build over the exact served bytes). Verify before installing so
// corrupt or tampered bytes never reach the volume — and so the same gate holds
// once third-party / R2 bytes serve through the same `/appstore` routes.
async function verifyHash(app: CatalogApp, file: CatalogFile, bytes: Uint8Array): Promise<void> {
	const expected = file.hash.replace(/^sha256-/, '')
	const buffer = bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength
	) as ArrayBuffer
	const digest = await crypto.subtle.digest('SHA-256', buffer)
	const actual = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
	if (actual !== expected) {
		throw new Error(`appstore: ${app.id}/${file.path} hash mismatch`)
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
