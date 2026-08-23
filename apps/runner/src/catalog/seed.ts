import type { ReleaseManifest, StoreApp, StoreIndex } from '@justfiles/app/appstore/protocol'

const PRODUCTION = 'https://justapps.run/'
type Store = {
	get(key: string): Promise<{ json<T>(): Promise<T> } | null>
	put(
		key: string,
		value: string | ReadableStream,
		options?: { httpMetadata: { contentType: string } }
	): Promise<unknown>
}

/** Copy the current public releases into an empty local store. */
export async function seed(store: Store): Promise<void> {
	const current = await store.get('store.json')
	if ((await current?.json<StoreIndex>())?.apps.length) return

	const index = await json<StoreIndex>(new URL('store.json', PRODUCTION))
	const apps = await Promise.all(index.apps.map((app) => copyApp(store, app)))
	await putJson(store, 'store.json', { ...index, apps })
}

async function copyApp(store: Store, app: StoreApp): Promise<StoreApp> {
	const manifest = await json<ReleaseManifest>(app.manifestUrl)
	if (manifest.id !== app.id) throw new Error(`seed ${app.id}: manifest id is ${manifest.id}`)

	const prefix = `apps/${app.id}/${manifest.version}`
	const base = new URL(`/v/${manifest.version}/`, app.manifestUrl)
	await Promise.all([
		...manifest.files.map(async ({ path }) => {
			const response = await download(new URL(path, base))
			if (!response.body) throw new Error(`seed ${path}: empty body`)
			await store.put(`${prefix}/files/${path}`, response.body)
		}),
		putJson(store, `${prefix}/manifest.json`, manifest),
		putJson(store, `apps/${app.id}/record.json`, {
			current: manifest.version,
			releases: { [manifest.version]: { state: 'ready' } }
		})
	])

	return {
		...app,
		name: manifest.name,
		description: manifest.description,
		version: manifest.version,
		iconUrl: manifest.icon ? new URL(manifest.icon, base).href : undefined
	}
}

const putJson = (store: Store, key: string, value: unknown) =>
	store.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } })

async function json<T>(url: string | URL): Promise<T> {
	return (await download(url)).json<T>()
}

async function download(url: string | URL): Promise<Response> {
	const response = await fetch(url)
	if (!response.ok) throw new Error(`seed ${url}: ${response.status}`)
	return response
}
