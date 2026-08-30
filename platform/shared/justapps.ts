import type { AppManifest } from '../../packages/app/app.ts'
import {
	MANIFEST_SCHEMA,
	type ReleaseManifest,
	STORE_SCHEMA,
	type StoreApp
} from '../../packages/app/appstore.protocol.ts'
import type { AppStore, CatalogApp } from '../../packages/app/appstore.ts'

export const RUNNER_STORE_URL = 'https://justapps.run/store.json'
export { MANIFEST_SCHEMA as RUNNER_MANIFEST_SCHEMA, STORE_SCHEMA as RUNNER_STORE_SCHEMA }
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

// Hosted apps this release seeds.
const BUILTIN_IDS = [
	'justfiles.code',
	'justfiles.files',
	'justfiles.settings',
	'justfiles.notes',
	'justfiles.paint',
	'justfiles.dictionary',
	'justfiles.read'
]
const REQUEST_TIMEOUT_MS = 10_000

export interface RunnerCatalogApp extends CatalogApp, StoreApp {
	manifest: AppManifest
	hash: string
}

interface RunnerAppStore extends AppStore {
	catalog(): Promise<RunnerCatalogApp[]>
	entries(): readonly StoreApp[]
}

// Primary apps win when IDs match. Keep each result tied to the store that supplied it.
export function mergeAppStores(primary: AppStore, runner: AppStore): AppStore {
	const source = new WeakMap<CatalogApp, AppStore>()
	const remember = (app: CatalogApp, store: AppStore) => {
		source.set(app, store)
		return app
	}
	return {
		async builtins() {
			const apps = (await primary.builtins()).map((app) => remember(app, primary))
			const ids = new Set(apps.map((app) => app.id))
			return [
				...apps,
				...(await runner.builtins())
					.filter((app) => !ids.has(app.id))
					.map((app) => remember(app, runner))
			]
		},
		async latest(id) {
			const app = await primary.latest(id)
			if (app) return remember(app, primary)
			const fallback = await runner.latest(id)
			return fallback ? remember(fallback, runner) : null
		},
		read: (app, path) =>
			(source.get(app) ?? ('manifestUrl' in app ? runner : primary)).read(app, path)
	}
}

// Load the index first. Load each app manifest once and only when needed.
// catalog() loads all manifests because the store UI lists every app.
export async function runnerAppStore(
	request: (url: string) => Promise<Response> = (url) =>
		fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
	storeUrl = RUNNER_STORE_URL
): Promise<RunnerAppStore | null> {
	let entries: StoreApp[]
	try {
		const response = await request(storeUrl)
		if (!response.ok) return null
		const index: unknown = await response.json()
		if (!isRecord(index) || index.schema !== STORE_SCHEMA || !Array.isArray(index.apps)) return null
		entries = index.apps.filter(isStoreEntry)
	} catch {
		return null
	}

	const byId = new Map(entries.map((entry) => [entry.id, entry]))
	const loaded = new Map<string, Promise<RunnerCatalogApp | null>>()
	const load = (entry: StoreApp): Promise<RunnerCatalogApp | null> => {
		const found = loaded.get(entry.id)
		if (found) return found
		const app = loadApp(entry, request)
		loaded.set(entry.id, app)
		return app
	}
	return {
		entries() {
			return entries
		},
		async catalog() {
			return (await Promise.all(entries.map(load))).filter(
				(app): app is RunnerCatalogApp => app !== null
			)
		},
		async builtins() {
			return (
				await Promise.all(
					BUILTIN_IDS.map((id) => {
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStoreEntry(value: unknown): value is StoreApp {
	return (
		isRecord(value) &&
		typeof value.id === 'string' &&
		typeof value.name === 'string' &&
		typeof value.version === 'string' &&
		typeof value.manifestUrl === 'string' &&
		(value.description === undefined || typeof value.description === 'string') &&
		(value.iconUrl === undefined || typeof value.iconUrl === 'string') &&
		(value.repository === undefined || typeof value.repository === 'string') &&
		(value.hash === undefined || typeof value.hash === 'string')
	)
}

async function loadApp(
	entry: StoreApp,
	request: (url: string) => Promise<Response>
): Promise<RunnerCatalogApp | null> {
	try {
		const response = await request(entry.manifestUrl)
		if (!response.ok) return null
		const release = (await response.json()) as ReleaseManifest
		if (
			release.schema !== MANIFEST_SCHEMA ||
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
}
