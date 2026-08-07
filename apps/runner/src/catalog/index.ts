import { importRelease } from './import'
import { type Resolved, readInfo, refreshApp } from './refresh-app'
import { type CatalogRefresh, refreshCatalog } from './refresh-catalog'

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
 * Every app we serve, for the root domain's index.
 *
 * Listed out of the store rather than out of the catalog snapshot, because the
 * store is what is actually reachable: an entry exists from the moment its PR
 * lands and hosts nothing until its first import completes.
 * This is the same walk `store.json` is specified to do — one `list` of `apps/`
 * and a read per app, no GitHub — and it collapses into a single read of that
 * projection once it exists. See kb/registry.md#storejson.
 */
export async function listApps(env: CloudflareBindings): Promise<AppMetadata[]> {
	const { delimitedPrefixes } = await env.STORE.list({ prefix: 'apps/', delimiter: '/' })
	const found = await Promise.all(
		delimitedPrefixes.map((prefix) => findApp(env, prefix.slice('apps/'.length, -1)))
	)
	return found.filter((app) => app !== null).sort((a, b) => a.name.localeCompare(b.name))
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
