import type { Kernel } from '@justfiles/app'
import type { Volume } from '@justfiles/fs'
import { appFileUrl, CATALOG_PATH, type Catalog, reconcileBuiltins } from '../../shared/appstore'

// Seed built-in apps into a LOCAL-ONLY profile's volume from the public
// `/appstore` assets (PWA-precached), so a signed-out / offline desktop has apps
// to launch with no backend. Synced (signed-in) profiles are materialized by the
// server instead — it owns the inos — so this must NOT run against them or it
// would double-seed. The boot path gates on "local-only" (Phase 4d wires that
// once the OS can boot without auth).
export async function seedBuiltins(kernel: Kernel, fs: Volume): Promise<void> {
	const res = await fetch(CATALOG_PATH)
	if (!res.ok) return
	const catalog = (await res.json()) as Catalog
	await reconcileBuiltins(kernel, fs, catalog, async (app, path) => {
		const file = await fetch(appFileUrl(app, path))
		if (!file.ok) throw new Error(`appstore: ${app.id}/${path} ${file.status}`)
		return new Uint8Array(await file.arrayBuffer())
	})
}
