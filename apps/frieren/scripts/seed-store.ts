// Seed the LOCAL app-store catalog for `pnpm dev`.
//
// The community catalog lives in the APPSTORE R2 bucket, filled by the deployed
// indexer cron. In local dev that bucket is an empty simulation and the cron
// never fires, so the store would show nothing. Fetch the live staging catalog
// (public, no auth) and write it into the local bucket via getPlatformProxy,
// which shares miniflare's `.wrangler/state` persistence with the dev server.
//
// Best-effort and idempotent: it overwrites the catalog each run (so it never
// goes stale), and if anything fails (offline, staging down) it just skips — dev
// still starts and the store falls back to built-ins.
import { getPlatformProxy } from 'wrangler'

const STAGING_CATALOG = 'https://staging.mykodama.app/store/catalog.json'
const CATALOG_KEY = 'catalog.json'

type AppStoreEnv = { APPSTORE: { put(key: string, value: ArrayBuffer): Promise<unknown> } }

async function main(): Promise<void> {
	let bytes: ArrayBuffer
	try {
		const res = await fetch(STAGING_CATALOG, {
			headers: { 'user-agent': 'curl/8' },
			signal: AbortSignal.timeout(8000)
		})
		if (!res.ok) throw new Error(`HTTP ${res.status}`)
		bytes = await res.arrayBuffer()
	} catch (e) {
		console.warn(`[seed-store] skipped (staging catalog unreachable): ${(e as Error).message}`)
		return
	}

	let dispose: (() => Promise<void>) | undefined
	try {
		const proxy = await getPlatformProxy<AppStoreEnv>()
		dispose = proxy.dispose
		await proxy.env.APPSTORE.put(CATALOG_KEY, bytes)
		const count = (
			JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) as { apps?: unknown[] }
		).apps?.length
		console.log(`[seed-store] seeded local APPSTORE from staging (${count ?? 0} app(s))`)
	} catch (e) {
		console.warn(`[seed-store] skipped (local R2 write failed): ${(e as Error).message}`)
	} finally {
		await dispose?.()
	}
}

await main()
