// frieren's app-store glue: built-in apps ship as static assets under
// `/appstore` (emitted by `vite-appstore.ts`), and the `AppStore` reconcile +
// catalog types live in `@justfiles/app/appstore`. This module keeps only the
// frieren-specific asset addressing: the catalog schema tag, its served path, the
// version-pathed per-file URL, and an `AppStore` over those assets.

import type { AppStore, Catalog, CatalogApp } from '@justfiles/app/appstore'

export const CATALOG_SCHEMA = 'frieren/appstore-catalog/v1'
export const CATALOG_PATH = '/appstore/catalog.json'

// The community feed: a second catalog, R2-backed and worker-served, carrying
// everything the deploy doesn't pre-ship — third-party apps and the first-party
// `computer.spud.*` apps distributed via npm. Each entry adds the source pointer
// (`npm` name + `publisher`) the client needs to resolve bytes from jsDelivr and
// show provenance on the consent sheet. `files[].path` is relative to the
// package's `dist/`, matching the built-in catalog.
export const COMMUNITY_CATALOG_SCHEMA = 'spud/community-catalog/v1'
export const COMMUNITY_CATALOG_PATH = '/appstore.json'

export interface CommunityCatalogApp extends CatalogApp {
	npm: string // npm package name; bytes resolve via jsDelivr
	publisher: string // `npm:<username>`, shown on the consent sheet
	repository?: string // linkified in the UI
	description?: string
}

export interface CommunityCatalog {
	schema: string
	apps: CommunityCatalogApp[]
}

// Version-pathed so a release is immutable and permanently cacheable.
export function appFileUrl(app: { id: string; version: string }, path: string): string {
	return `/appstore/apps/${app.id}/${app.version}/${path}`
}

// An AppStore over frieren's `/appstore` assets. `fetcher` is the caller's fetch
// — the browser `fetch` for the local-only client, the `ASSETS` binding's fetch
// for the worker. frieren's catalog carries only built-ins (co-shipped with the
// deploy), so `builtins()` returns them all and `latest(id)` resolves from the
// same set; a future public catalog would serve these from per-id/paginated
// endpoints instead. Returns null when no catalog is published so callers skip
// reconcile cleanly (offline first boot, or an asset build that hasn't run).
export async function httpAppStore(
	fetcher: (path: string) => Promise<Response>
): Promise<AppStore | null> {
	const res = await fetcher(CATALOG_PATH)
	if (!res.ok) return null
	const catalog = (await res.json()) as Catalog
	const byId = new Map(catalog.apps.map((app) => [app.id, app]))
	return {
		async builtins() {
			return catalog.apps
		},
		async latest(id) {
			return byId.get(id) ?? null
		},
		async read(app, path) {
			const file = await fetcher(appFileUrl(app, path))
			if (!file.ok) throw new Error(`appstore: ${app.id}/${path} ${file.status}`)
			return new Uint8Array(await file.arrayBuffer())
		}
	}
}
