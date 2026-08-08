import type { CatalogApp, CatalogFile } from '@justfiles/app/appstore'
import { importRelease } from './import'
import { type Resolved, readInfo, refreshApp } from './refresh-app'
import { type CatalogRefresh, readCatalog, refreshCatalog } from './refresh-catalog'

/**
 * Imports per run. Ten maximally-sized bundles is ~5,000 subrequests, half the
 * per-invocation cap, leaving the polling pass room. Raise it for a backfill.
 */
const IMPORT_BUDGET = 10

export interface AppMetadata {
	id: string
	name: string
	version: string
	/** Bundle-relative, for the web app manifest. Absent when the app ships none. */
	icon?: string
}

/**
 * What we host under an id, or null when we host nothing there — which is every
 * id until its first import completes.
 *
 * Called once per PAGE load and never per asset: the document it renders emits
 * version-pinned URLs, and those resolve by string construction. Two reads, not
 * one, because `info.json` deliberately carries no display metadata — a second
 * copy of an app's name would be a second thing that can be wrong, and the read
 * is behind the same cache as the first.
 */
export async function findApp(env: CloudflareBindings, id: string): Promise<AppMetadata | null> {
	const version = (await readInfo(env, id))?.current
	if (!version) return null

	const spec = await env.STORE.get(`apps/${id}/${version}/spec.json`)
	if (!spec) return null
	const { name, icon } = await spec.json<{ name: string; icon?: string }>()
	return { id, name, version, icon }
}

/**
 * One app as a store hands it out: everything a device needs to install it,
 * minus the one field only the request knows.
 *
 * It is `CatalogApp` — the consumer's own type — so the two cannot drift, plus
 * the provenance a consent sheet shows before granting anything. `baseUrl` is
 * absent for the reason it is absent from `spec.json`: it is the only place an
 * app id would appear in stored data, and the route that serves this fills it in
 * from the origin the app is reachable at.
 */
export interface StoreApp extends CatalogApp {
	description?: string
	/** `owner/name`, from the catalog entry. Where this app came from. */
	repo?: string
}

/**
 * One app's full catalog entry, or null when we do not host it.
 *
 * Three reads rather than `findApp`'s two, which is why it is a separate
 * function: `files.json` describes EVERY file — the reducer included, which
 * `spec.json` deliberately omits — and the app's own page has no use for it.
 * A release imported before `files.json` existed has none, and reads as
 * unhosted rather than as an app missing half its manifest.
 */
export async function storeApp(env: CloudflareBindings, id: string): Promise<StoreApp | null> {
	const version = (await readInfo(env, id))?.current
	if (!version) return null

	const prefix = `apps/${id}/${version}`
	const [spec, files] = await Promise.all([
		env.STORE.get(`${prefix}/spec.json`),
		env.STORE.get(`${prefix}/files.json`)
	])
	if (!spec || !files) return null

	const { name, icon, description, capabilities } =
		await spec.json<Omit<StoreApp, 'id' | 'version' | 'files'>>()
	return {
		id,
		name,
		version,
		icon,
		description,
		capabilities,
		files: await files.json<CatalogFile[]>()
	}
}

/**
 * Every app we serve — the root domain's index, and the store feed it renders
 * from, so the page and the API can never disagree about what is on offer.
 *
 * Listed out of the store rather than out of the catalog snapshot, because the
 * store is what is actually reachable: an entry exists from the moment its PR
 * lands and hosts nothing until its first import completes. The snapshot is
 * still read, for the two things only it knows — whether an entry is still
 * `active`, and which repository it came from.
 *
 * This is the walk `store.json` is specified to do: one `list` of `apps/` and a
 * read per app, no GitHub. Computed per request rather than stored, because
 * with the whole answer this cheap a stored projection would only add something
 * else that can be stale. See kb/registry.md#storejson.
 */
export async function listApps(env: CloudflareBindings): Promise<StoreApp[]> {
	// Paged to the end: `list` truncates, and an app past the first page would drop
	// off the index while its own origin carried on serving it.
	const prefixes: string[] = []
	let cursor: string | undefined
	do {
		const page = await env.STORE.list({ prefix: 'apps/', delimiter: '/', cursor })
		prefixes.push(...page.delimitedPrefixes)
		cursor = page.truncated ? page.cursor : undefined
	} while (cursor)

	const catalog = await readCatalog(env)
	const found = await Promise.all(
		prefixes.map(async (prefix) => {
			const id = prefix.slice('apps/'.length, -1)
			// A parked entry keeps its bytes — a device pinned to one of its versions
			// must go on resolving it — but stops being offered, which is the whole
			// difference between removing an app and deleting it.
			//
			// Only what the snapshot actually says is parked. An id it does not
			// mention is still listed, because the snapshot is derived state that a
			// lost read rebuilds on the next tick, and the alternative is a store
			// that empties itself while every app it holds is still being served.
			const entry = catalog?.entries[id]
			if (entry && entry.status !== 'active') return null
			const app = await storeApp(env, id)
			return app && { ...app, repo: entry?.repo }
		})
	)
	return found.filter((app) => app !== null).sort((a, b) => a.name.localeCompare(b.name))
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
	return (await readInfo(env, id))?.releases[version]?.state === 'ready'
}

export interface Refresh extends CatalogRefresh {
	/** Releases resolved this run whose bytes we do not hold yet, by app id. */
	imports: Record<string, Resolved>
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

	return { ...result, imports }
}
