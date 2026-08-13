// Frieren's two app sources: bundled apps co-ship under `/appstore`; Runner apps
// keep their immutable payloads at justapps.run. A host-owned allowlist promotes
// first-party Runner apps to trusted built-ins. Runner is only their delivery
// channel; every other Runner app stays behind install and escalation consent.

import type { AppManifest } from '@justfiles/app'
import type { AppStore, Catalog, CatalogApp, CatalogFile } from '@justfiles/app/appstore'

export const CATALOG_SCHEMA = 'frieren/appstore-catalog/v1'
export const CATALOG_PATH = '/appstore/catalog.json'
export const RUNNER_STORE_URL = 'https://justapps.run/store.json'
export const RUNNER_STORE_SCHEMA = 'justapps/store/v1'
export const RUNNER_MANIFEST_SCHEMA = 'justapps/manifest/v1'
export const RUNNER_CACHE_NAME = 'justapps'
export const RUNNER_CACHE_MAX_ENTRIES = 500

const TRUSTED_PREINSTALLED_RUNNER_IDS = ['justfiles.notes']

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

interface RunnerStoreEntry {
	id: string
	name: string
	description?: string
	version: string
	iconUrl?: string
	manifestUrl: string
	repository?: string
}

interface RunnerStoreIndex {
	schema: string
	apps: RunnerStoreEntry[]
}

interface RunnerManifest extends Omit<AppManifest, 'files'> {
	schema: string
	version: string
	hash: string
	files: CatalogFile[]
}

export interface RunnerCatalogApp extends CatalogApp {
	description?: string
	iconUrl?: string
	manifestUrl: string
	repository?: string
	manifest: AppManifest
	hash: string
}

export interface RunnerAppStore extends AppStore {
	catalog(): Promise<RunnerCatalogApp[]>
}

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

// Fetch the small index up front, then each mutable manifest pointer at most once
// and only when its id is needed. Reconcile asks for installed ids; browsing calls
// catalog() and deliberately hydrates every entry.
export async function runnerAppStore(
	request: (url: string) => Promise<Response> = (url) => fetch(url)
): Promise<RunnerAppStore | null> {
	const storeResponse = await request(RUNNER_STORE_URL)
	if (!storeResponse.ok) return null
	const index = (await storeResponse.json()) as RunnerStoreIndex
	if (index.schema !== RUNNER_STORE_SCHEMA || !Array.isArray(index.apps)) return null

	const byId = new Map(index.apps.map((entry) => [entry.id, entry]))
	const loaded = new Map<string, Promise<RunnerCatalogApp | null>>()
	const load = (entry: RunnerStoreEntry): Promise<RunnerCatalogApp | null> => {
		let app = loaded.get(entry.id)
		if (!app) {
			app = (async () => {
				try {
					const response = await request(entry.manifestUrl)
					if (!response.ok) return null
					const release = (await response.json()) as RunnerManifest
					if (
						release.schema !== RUNNER_MANIFEST_SCHEMA ||
						release.id !== entry.id ||
						!Array.isArray(release.files)
					)
						return null
					const { schema: _schema, files, hash, ...manifest } = release
					return {
						...entry,
						name: release.name,
						description: release.description,
						version: release.version,
						icon: release.icon,
						capabilities: release.capabilities,
						files,
						hash,
						manifest,
						baseUrl: new URL('.', response.url).href
					}
				} catch {
					return null
				}
			})()
			loaded.set(entry.id, app)
		}
		return app
	}
	return {
		async catalog() {
			return (await Promise.all(index.apps.map(load))).filter(
				(app): app is RunnerCatalogApp => app !== null
			)
		},
		async builtins() {
			return (
				await Promise.all(
					TRUSTED_PREINSTALLED_RUNNER_IDS.map((id) => {
						const entry = byId.get(id)
						return entry ? load(entry) : null
					})
				)
			).filter((app): app is RunnerCatalogApp => app !== null)
		},
		async latest(id) {
			const entry = byId.get(id)
			return entry ? load(entry) : null
		},
		async read(app, path) {
			const file = await request(`${app.baseUrl?.replace(/\/$/, '')}/${path}`)
			if (!file.ok) throw new Error(`runner: ${app.id}/${path} ${file.status}`)
			return new Uint8Array(await file.arrayBuffer())
		}
	}
}

// Bundled apps remain authoritative. Host-trusted first-party Runner apps join
// the built-in set and may update without capability re-consent. Every other
// Runner app is installed from the store UI and keeps the escalation guard.
export async function bootAppStore(
	fetcher: (path: string) => Promise<Response>
): Promise<AppStore | null> {
	const [builtin, runner] = await Promise.all([httpAppStore(fetcher), runnerAppStore(fetcher)])
	if (!builtin) return runner
	if (!runner) return builtin
	return {
		async builtins() {
			const bundled = await builtin.builtins()
			const bundledIds = new Set(bundled.map((app) => app.id))
			return [...bundled, ...(await runner.builtins()).filter((app) => !bundledIds.has(app.id))]
		},
		async latest(id) {
			return (await builtin.latest(id)) ?? (await runner.latest(id))
		},
		read: (app, path) =>
			(app as RunnerCatalogApp).manifestUrl ? runner.read(app, path) : builtin.read(app, path)
	}
}
