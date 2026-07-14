// The community-store indexer's I/O shell: npm search + jsDelivr metadata in,
// the community catalog to R2 out, plus the public read route. All third-party
// bytes stay on jsDelivr — this only ever fetches the file tree (hashes) and the
// small `dist/manifest.json`; app code (app.js/gui.js) is referenced by hash and
// never pulled here. The pure decision logic lives in `indexer.ts`.

import { COMMUNITY_CATALOG_SCHEMA, type CommunityCatalog } from '../../shared/appstore.ts'
import { DENYLIST } from './denylist.ts'
import { buildCatalog, distFiles, type IndexInput, type JsDelivrNode } from './indexer.ts'

const CATALOG_KEY = 'appstore.json'
const NPM_SEARCH = 'https://registry.npmjs.org/-/v1/search'
const JSDELIVR_DATA = 'https://data.jsdelivr.com/v1/packages/npm'
const JSDELIVR_CDN = 'https://cdn.jsdelivr.net/npm'
const KEYWORD = 'spud-app'
const PAGE = 250 // npm search max page size
const MAX_PAGES = 20 // safety cap (<=5000 apps for v1)
const UA = 'spud-appstore-indexer (+https://spud.computer)'

interface NpmHit {
	name: string
	version: string
	publisher: string
	repository?: string
	description?: string
}

interface NpmSearchResponse {
	objects: {
		package: {
			name: string
			version: string
			description?: string
			publisher?: { username?: string }
			links?: { repository?: string }
		}
	}[]
	total: number
}

async function fetchJson<T>(url: string): Promise<T | null> {
	const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } })
	if (!res.ok) return null
	return (await res.json()) as T
}

// Every `spud-app`-keyworded package (latest version), paginated.
async function npmCandidates(): Promise<NpmHit[]> {
	const hits: NpmHit[] = []
	for (let page = 0; page < MAX_PAGES; page++) {
		const url = `${NPM_SEARCH}?text=keywords:${KEYWORD}&size=${PAGE}&from=${page * PAGE}`
		const body = await fetchJson<NpmSearchResponse>(url)
		if (!body?.objects?.length) break
		for (const { package: p } of body.objects) {
			hits.push({
				name: p.name,
				version: p.version,
				publisher: `npm:${p.publisher?.username ?? 'unknown'}`,
				repository: normalizeRepo(p.links?.repository),
				description: p.description
			})
		}
		if ((page + 1) * PAGE >= body.total) break
	}
	return hits
}

function normalizeRepo(repo?: string): string | undefined {
	return repo?.replace(/^git\+/, '').replace(/\.git$/, '')
}

async function jsdelivrTree(name: string, version: string): Promise<JsDelivrNode[] | null> {
	const body = await fetchJson<{ files?: JsDelivrNode[] }>(`${JSDELIVR_DATA}/${name}@${version}`)
	return body?.files ?? null
}

async function jsdelivrManifest(name: string, version: string): Promise<string | null> {
	const res = await fetch(`${JSDELIVR_CDN}/${name}@${version}/dist/manifest.json`, {
		headers: { 'user-agent': UA }
	})
	return res.ok ? await res.text() : null
}

async function readCatalog(env: Env): Promise<CommunityCatalog> {
	const obj = await env.APPSTORE?.get(CATALOG_KEY)
	if (!obj) return { schema: COMMUNITY_CATALOG_SCHEMA, apps: [] }
	try {
		return JSON.parse(await obj.text()) as CommunityCatalog
	} catch {
		return { schema: COMMUNITY_CATALOG_SCHEMA, apps: [] }
	}
}

// Run the full index: search npm, fetch metadata for package@versions not already
// pinned at that version (already-indexed ones persist through the merge), build
// the catalog, write it to R2. Read-only against everything but our own R2 object.
export async function runIndexer(env: Env): Promise<void> {
	if (!env.APPSTORE) throw new Error('indexer: APPSTORE R2 binding missing')
	const previous = await readCatalog(env)
	const prevByNpm = new Map(previous.apps.map((a) => [a.npm, a]))
	const hits = await npmCandidates()

	const inputs: IndexInput[] = []
	for (const hit of hits) {
		// Skip re-fetching a package@version already pinned; the merge retains it.
		if (prevByNpm.get(hit.name)?.version === hit.version) continue
		const tree = await jsdelivrTree(hit.name, hit.version)
		if (!tree) continue
		inputs.push({
			npm: hit.name,
			version: hit.version,
			publisher: hit.publisher,
			repository: hit.repository,
			description: hit.description,
			manifest: await jsdelivrManifest(hit.name, hit.version),
			files: distFiles(tree)
		})
	}

	const { catalog, flags } = buildCatalog(inputs, previous, DENYLIST)
	if (flags.length) console.warn('appstore indexer flags:', JSON.stringify(flags))
	await env.APPSTORE.put(CATALOG_KEY, JSON.stringify(catalog), {
		httpMetadata: { contentType: 'application/json' }
	})
}

// Public, unauthenticated read of the community catalog (served at
// `/appstore.json` — the store feed). An empty catalog before the first run so
// clients resolve cleanly.
export async function serveCommunityCatalog(env: Env): Promise<Response> {
	const obj = await env.APPSTORE?.get(CATALOG_KEY)
	const headers = { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' }
	if (!obj) {
		return new Response(JSON.stringify({ schema: COMMUNITY_CATALOG_SCHEMA, apps: [] }), { headers })
	}
	return new Response(obj.body, { headers })
}
