import type { AppManifest } from '../../packages/app/app.ts'
import type { AppStore, CatalogApp, CatalogFile } from '../../packages/app/appstore.ts'

export const RUNNER_STORE_URL = 'https://justapps.run/store.json'
export const RUNNER_STORE_SCHEMA = 'justapps/store/v1'
export const RUNNER_MANIFEST_SCHEMA = 'justapps/manifest/v1'
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

const TRUSTED_PREINSTALLED_RUNNER_IDS = ['justfiles.notes', 'justfiles.paint']

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

// Packaged apps stay authoritative. JustApps adds only IDs that this host does not
// already own, and the catalog object's manifestUrl routes its immutable file reads.
export function mergeAppStores(primary: AppStore, runner: RunnerAppStore): AppStore {
	return {
		async builtins() {
			const primaryApps = await primary.builtins()
			const primaryIds = new Set(primaryApps.map((app) => app.id))
			return [...primaryApps, ...(await runner.builtins()).filter((app) => !primaryIds.has(app.id))]
		},
		async latest(id) {
			return (await primary.latest(id)) ?? (await runner.latest(id))
		},
		read: (app, path) => ('manifestUrl' in app ? runner.read(app, path) : primary.read(app, path))
	}
}

// Fetch the small index up front, then each mutable manifest pointer at most once
// and only when its id is needed. Reconcile asks for installed ids; browsing calls
// catalog() and deliberately hydrates every entry.
export async function runnerAppStore(
	request: (url: string) => Promise<Response> = (url) => fetch(url)
): Promise<RunnerAppStore | null> {
	let index: RunnerStoreIndex
	try {
		const response = await request(RUNNER_STORE_URL)
		if (!response.ok) return null
		index = (await response.json()) as RunnerStoreIndex
	} catch {
		return null
	}
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
