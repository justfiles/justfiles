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
	description?: string
	version: string
	/** The bytes at a bundle path, streamed, or null when we hold no such file. */
	asset(path: string): Promise<ReadableStream | null>
}

/**
 * What we host under an id, or null when we host nothing there — which is every
 * id until an import has run and its first release has been approved.
 *
 * One lookup, per page load rather than per asset: `info.json` names the live
 * version and `spec.json` describes it. See kb/registry.md#serving.
 */
export async function findApp(env: CloudflareBindings, id: string): Promise<AppMetadata | null> {
	const version = (await readInfo(env, id))?.current
	if (!version) return null

	const spec = await env.STORE.get(`apps/${id}/${version}/spec.json`)
	if (!spec) return null
	const { name, description } = await spec.json<{ name: string; description?: string }>()

	/**
	 * **Resolves into `apps/{id}/{version}/files/` and nowhere else.** Grouping an
	 * app's state and its content under one prefix put `info.json` — `approved`,
	 * the poll ETags, the whole release history — beside the bytes we serve. The
	 * `version` segment is what stops a request path climbing out to reach it.
	 */
	const asset = async (path: string) =>
		(await env.STORE.get(`apps/${id}/${version}/files/${path.replace(/^\//, '')}`))?.body ?? null

	return { id, name, description, version, asset }
}

export async function publish() {}

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
