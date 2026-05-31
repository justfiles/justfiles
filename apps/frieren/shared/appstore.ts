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
function disabledMarker(id: string): string {
	return `/system/apps/disabled/${id}.json`
}

// Seed missing built-ins, overwrite version mismatches, skip equal, and never
// resurrect a disabled one. `read` fetches a file's bytes (server: env.ASSETS;
// client: fetch). `force` overwrites regardless of version (dev: pick up local
// edits without a version bump).
export async function reconcileBuiltins(
	kernel: Kernel,
	fs: Volume,
	catalog: Catalog,
	read: (app: CatalogApp, path: string) => Promise<Uint8Array>,
	force = false
): Promise<void> {
	const installed = new Map((await kernel.list()).map((m) => [m.id, m.version]))
	for (const app of catalog.apps) {
		if (!force && installed.get(app.id) === app.version) continue
		if (await fs.exists(disabledMarker(app.id))) continue
		const files = new Map<string, Uint8Array>()
		for (const file of app.files) files.set(safeBundlePath(file.path), await read(app, file.path))
		await kernel.install(bundleFromFiles(files))
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
