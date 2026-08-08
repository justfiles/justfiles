import { encodeLabel } from '../id'
import { type ReleaseManifest, STORE_SCHEMA, type StoreApp, type StoreIndex } from '../protocol'
import { importRelease } from './import'
import { type Resolved, readRecord, refreshApp } from './refresh-app'
import { type Catalog, type CatalogRefresh, refreshCatalog } from './refresh-catalog'

/**
 * Imports per run. Ten maximally-sized bundles is ~5,000 subrequests, half the
 * per-invocation cap, leaving the polling pass room. Raise it for a backfill.
 */
const IMPORT_BUDGET = 10

const STORE_KEY = 'store.json'

/**
 * The release we host under an id, or null when we host nothing there — which is
 * every id until its first import completes.
 *
 * Two reads, because `record.json` deliberately carries no display metadata — a
 * second copy of an app's name would be a second thing that can be wrong. Called
 * once per PAGE load and never per asset: the document it renders emits
 * version-pinned URLs, and those resolve by string construction.
 */
export async function findApp(
	env: CloudflareBindings,
	id: string
): Promise<ReleaseManifest | null> {
	const version = (await readRecord(env, id))?.current
	if (!version) return null
	const obj = await env.STORE.get(`apps/${id}/${version}/manifest.json`)
	return obj ? await obj.json<ReleaseManifest>() : null
}

/**
 * Whether a version may be served at all.
 *
 * The bytes of a release land before the record that publishes them, so a
 * version that is merely *guessable* is not a version we have finished importing.
 * Without this, a request naming one mid-import could be answered out of a
 * half-written release and cached for a year as immutable — over bytes the retry
 * then rewrites. It is also what takes a yanked release out of reach.
 */
export async function servable(
	env: CloudflareBindings,
	id: string,
	version: string
): Promise<boolean> {
	return (await readRecord(env, id))?.releases[version]?.state === 'ready'
}

/** The browse index as stored. The root site's only read. */
export async function readStore(env: CloudflareBindings): Promise<StoreIndex> {
	const obj = await env.STORE.get(STORE_KEY)
	return (await obj?.json<StoreIndex>()) ?? { schema: STORE_SCHEMA, apps: [] }
}

/**
 * Rebuild `store.json` from R2 alone — one `list` of `apps/` and two reads per
 * app, and never a GitHub request. If rebuilding it ever needed the network it
 * would have silently become a second mirror of upstream, and the snapshot is
 * deliberately the only one.
 *
 * Unconditional, and the last thing a refresh does: if a previous rebuild failed
 * after a release was published, the next refresh repairs it. That is what buys
 * us no dirty-marker protocol — the cost is one rebuild per tick over state we
 * already have to read.
 */
export async function rebuildStore(env: CloudflareBindings, catalog: Catalog): Promise<StoreIndex> {
	// Paged to the end: `list` truncates, and an app past the first page would drop
	// off the index while its own origin carried on serving it.
	const prefixes: string[] = []
	let cursor: string | undefined
	do {
		const page = await env.STORE.list({ prefix: 'apps/', delimiter: '/', cursor })
		prefixes.push(...page.delimitedPrefixes)
		cursor = page.truncated ? page.cursor : undefined
	} while (cursor)

	const found = await Promise.all(
		prefixes.map(async (prefix): Promise<StoreApp | null> => {
			const id = prefix.slice('apps/'.length, -1)
			const manifest = await findApp(env, id)
			if (!manifest) return null

			// Absolute, because a browse index is read from other origins than the one
			// it lists. `manifestUrl` is the app's mutable pointer rather than this
			// release's manifest: a client that follows it gets the current release and
			// derives the payload base from where it landed.
			const origin = `https://${encodeLabel(id)}.${env.ROOT_DOMAIN}`
			return {
				id,
				name: manifest.name,
				description: manifest.description,
				version: manifest.version,
				iconUrl: manifest.icon && `${origin}/v/${manifest.version}/${manifest.icon}`,
				manifestUrl: `${origin}/manifest.json`,
				repository: catalog.entries[id]?.repo && `https://github.com/${catalog.entries[id]?.repo}`
			}
		})
	)

	const index: StoreIndex = {
		schema: STORE_SCHEMA,
		apps: found.filter((app) => app !== null).sort((a, b) => a.name.localeCompare(b.name))
	}
	await env.STORE.put(STORE_KEY, JSON.stringify(index), {
		httpMetadata: { contentType: 'application/json' }
	})
	return index
}

export interface Refresh extends CatalogRefresh {
	/** Releases resolved this run whose bytes we do not hold yet, by app id. */
	imports: Record<string, Resolved>
	/** The projection this run left behind. */
	store: StoreIndex
}

/** Reconcile everything: the catalog first, then each app it lists. */
export async function refresh(env: CloudflareBindings): Promise<Refresh> {
	const result = await refreshCatalog(env)
	const { catalog, touched, deleted } = result
	if (touched.length) console.info('catalog entries changed:', touched.join(', '))
	if (deleted.length) console.warn('catalog entries deleted:', deleted.join(', '))

	// Every active entry, not just the touched ones: a release is discovered and
	// never declared, so an entry unchanged for a year still has to be asked.
	const imports: Record<string, Resolved> = {}
	for (const [id, entry] of Object.entries(catalog.entries)) {
		if (entry.status !== 'active') continue
		try {
			const resolved = await refreshApp(env, id, entry)
			if (resolved) imports[id] = resolved
		} catch (err) {
			// The backstop for the one class of failure `refreshApp` cannot record —
			// its own reads and writes. One broken app never stops the others.
			console.error(`refresh ${id}:`, err)
		}
	}

	// Detecting and fetching are separate calls, so moving the fetch onto a Queue
	// is a change to this loop and nothing else. See kb/registry.md.
	//
	// Budgeted because an import spends roughly one subrequest per bundle file
	// against a 10,000 per-invocation cap, so a cold start on a fresh bucket is
	// the one case that could exhaust it. Whatever is skipped keeps its previous
	// ETags and is resolved again next run, so the backlog drains on its own.
	for (const [id, resolved] of Object.entries(imports).slice(0, IMPORT_BUDGET)) {
		const repo = catalog.entries[id]?.repo
		if (repo) await importRelease(env, id, repo, resolved)
	}

	return { ...result, imports, store: await rebuildStore(env, catalog) }
}
