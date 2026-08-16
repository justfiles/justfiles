import type { AppManifest } from '../../packages/app/app.ts'
import type { AppStore, CatalogApp, CatalogFile } from '../../packages/app/appstore.ts'

export const RUNNER_STORE_URL = 'https://justapps.run/store.json'
export const RUNNER_STORE_SCHEMA = 'justapps/store/v1'
export const RUNNER_MANIFEST_SCHEMA = 'justapps/manifest/v1'
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

const BUILTIN_IDS = ['justfiles.notes', 'justfiles.paint']
const REQUEST_TIMEOUT_MS = 10_000

interface StoreEntry {
	id: string
	name: string
	description?: string
	version: string
	iconUrl?: string
	manifestUrl: string
	repository?: string
}

interface Release extends Omit<AppManifest, 'files'> {
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

interface RunnerAppStore extends AppStore {
	catalog(): Promise<RunnerCatalogApp[]>
}

// Packaged apps win when IDs match. manifestUrl sends hosted reads to JustApps.
export function mergeAppStores(primary: AppStore, runner: AppStore): AppStore {
	return {
		async builtins() {
			const apps = await primary.builtins()
			const ids = new Set(apps.map((app) => app.id))
			return [...apps, ...(await runner.builtins()).filter((app) => !ids.has(app.id))]
		},
		async latest(id) {
			return (await primary.latest(id)) ?? (await runner.latest(id))
		},
		read: (app, path) => ('manifestUrl' in app ? runner.read(app, path) : primary.read(app, path))
	}
}

// Load the index first. Load each app manifest once and only when needed.
// catalog() loads all manifests because the store UI lists every app.
export async function runnerAppStore(
	request: (url: string) => Promise<Response> = (url) =>
		fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
): Promise<RunnerAppStore | null> {
	let entries: StoreEntry[]
	try {
		const response = await request(RUNNER_STORE_URL)
		if (!response.ok) return null
		const index: unknown = await response.json()
		if (!isRecord(index) || index.schema !== RUNNER_STORE_SCHEMA || !Array.isArray(index.apps))
			return null
		entries = index.apps.filter(isStoreEntry)
	} catch {
		return null
	}

	const byId = new Map(entries.map((entry) => [entry.id, entry]))
	const loaded = new Map<string, Promise<RunnerCatalogApp | null>>()
	const load = (entry: StoreEntry): Promise<RunnerCatalogApp | null> => {
		const found = loaded.get(entry.id)
		if (found) return found
		const app = loadApp(entry, request)
		loaded.set(entry.id, app)
		return app
	}
	return {
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

function isStoreEntry(value: unknown): value is StoreEntry {
	return (
		isRecord(value) &&
		typeof value.id === 'string' &&
		typeof value.name === 'string' &&
		typeof value.version === 'string' &&
		typeof value.manifestUrl === 'string' &&
		(value.description === undefined || typeof value.description === 'string') &&
		(value.iconUrl === undefined || typeof value.iconUrl === 'string') &&
		(value.repository === undefined || typeof value.repository === 'string')
	)
}

async function loadApp(
	entry: StoreEntry,
	request: (url: string) => Promise<Response>
): Promise<RunnerCatalogApp | null> {
	try {
		const response = await request(entry.manifestUrl)
		if (!response.ok) return null
		const release = (await response.json()) as Release
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
}
