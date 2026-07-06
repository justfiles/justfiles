import type { Kernel } from '@justfiles/app'
import { reconcile } from '@justfiles/app/appstore'
import type { Volume } from '@justfiles/fs'
import { httpAppStore } from '../../shared/appstore'

// Seed built-in apps into a LOCAL-ONLY profile's volume from the public
// `/appstore` assets (PWA-precached), so a signed-out / offline desktop has apps
// to launch with no backend. Synced (signed-in) profiles are materialized by the
// server instead — it owns the inos — so this must NOT run against them or it
// would double-seed. The boot path gates on "local-only" (Phase 4d wires that
// once the OS can boot without auth).
export async function seedBuiltins(kernel: Kernel, fs: Volume): Promise<void> {
	const store = await httpAppStore((path) => fetch(path))
	if (store) await reconcile(kernel, fs, store)
}
