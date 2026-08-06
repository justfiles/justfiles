/**
 * The store, until R2: an app is a directory under `bin/` named by its id, and
 * Vite inlines each file into the Worker at build time. A lookup is an exact key
 * into that record, so neither an id nor a path can reach outside `bin/`.
 */
const files = import.meta.glob('../bin/*/**', {
	query: '?raw',
	import: 'default'
}) as Record<string, () => Promise<string>>

export interface AppMetadata {
	id: string
	name: string
	description?: string
	version?: string
	asset(path: string): Promise<string | null>
}

/** What we host under an id, or null when we host nothing there. */
export async function findApp(id: string): Promise<AppMetadata | null> {
	// Routes hand over a request path (`/gui.js`), the manifest a bare one (`gui.js`).
	const asset = async (path: string) =>
		(await files[`../bin/${id}/${path.replace(/^\//, '')}`]?.()) ?? null

	const manifest = await asset('manifest.json')
	if (!manifest) return null

	// The directory is the id we serve under; the manifest only describes the app.
	const { name, description, version } = JSON.parse(manifest) as Omit<AppMetadata, 'id' | 'asset'>
	return { id, name, description, version, asset }
}

export async function publish() {}

/**
 * refresh catalog agianst the https://github.com/justfiles/app-catalog
 */
export async function refresh() {
	// iterate all apps,
	// - add new app to our record (db), put assets in R2.
	// - if already exists, skip
	// - if new version, update
	// - questions:
	//   - do we keep all versions in history or overwrite only copy?
	//   - should we use D1 for records? show me the schema design
	//   - should optimize to track delta instead of interate all each time, any suggestions?
	//   - any concerns running this as a cron job on cloudflare workers. (perf, time, cost)
}
