// Frieren's built app source. JustApps is shared with other hosts in platform/shared.

import type { AppStore, Catalog } from '@justfiles/app/appstore'
import { mergeAppStores, runnerAppStore } from '../../shared/justapps'

export const CATALOG_SCHEMA = 'frieren/appstore-catalog/v1'
export const CATALOG_PATH = '/appstore/catalog.json'
export const RUNNER_CACHE_NAME = 'justapps'
export const RUNNER_CACHE_MAX_ENTRIES = 500

export function appBaseUrl(app: { id: string; version: string }): string {
	return `/appstore/apps/${app.id}/${app.version}`
}

export function appFileUrl(app: { id: string; version: string }, path: string): string {
	return `${appBaseUrl(app)}/${path}`
}

export async function httpAppStore(
	fetcher: (path: string) => Promise<Response>
): Promise<AppStore | null> {
	const res = await fetcher(CATALOG_PATH)
	if (!res.ok) return null
	const catalog = (await res.json()) as Catalog
	const apps = catalog.apps.map((app) => ({ ...app, baseUrl: appBaseUrl(app) }))
	const byId = new Map(apps.map((app) => [app.id, app]))
	return {
		async builtins() {
			return apps
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

// Bundled apps remain authoritative. A local Runner store wins over production.
export async function bootAppStore(
	fetcher: (path: string) => Promise<Response>,
	localStoreUrl = import.meta.env.VITE_FRIEREN_DEV_APP_STORE as string | undefined
): Promise<AppStore | null> {
	const stores = (
		await Promise.all([
			httpAppStore(fetcher),
			localStoreUrl ? runnerAppStore(fetcher, localStoreUrl) : null,
			runnerAppStore(fetcher)
		])
	).filter((store): store is AppStore => store !== null)
	return stores.reduce<AppStore | null>(
		(merged, store) => (merged ? mergeAppStores(merged, store) : store),
		null
	)
}
