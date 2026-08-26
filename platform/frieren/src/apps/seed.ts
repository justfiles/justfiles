import type { Kernel } from '@justfiles/app'
import { installApp, materialise, reconcile } from '@justfiles/app/appstore'
import type { Volume } from '@justfiles/fs'
import { runnerAppStore } from '../../../shared/justapps'
import { bootAppStore } from '../../shared/appstore'

// The client is the single materialiser of built-in apps. On every boot it makes
// the volume match the release: `materialise` installs any built-in that's
// missing — so a newly-shipped built-in lands for existing users, not just
// empty-volume first boots — and `reconcile` updates the ones already installed.
// Both are idempotent (materialise only installs what's absent; reconcile is
// monotonic), so re-running each boot is cheap when nothing changed. Applied via
// this client kernel and synced up — the server never materialises.
export async function seedBuiltins(kernel: Kernel, fs: Volume): Promise<void> {
	const store = await bootAppStore((path) => fetch(path))
	if (!store) return
	await materialise(kernel, store)
	await reconcile(kernel, fs, store)
}

// Re-run the update pass when the `/applications` tree changes — a synced-down
// bundle or a local install. Monotonic + idempotent, so the launcher's structural
// watch can fire it freely. No-ops offline / before any catalog exists.
export async function reconcileInstalled(kernel: Kernel, fs: Volume): Promise<void> {
	const store = await bootAppStore((path) => fetch(path))
	if (store) await reconcile(kernel, fs, store)
}

// The local store changes often. Compare its small manifest each second, but do
// not run the full reconciliation pass or prefetch every hosted app each time.
export async function reconcileLocalStore(kernel: Kernel, storeUrl: string): Promise<void> {
	const store = await runnerAppStore((path) => fetch(path), storeUrl)
	if (!store) return
	const installed = new Map((await kernel.list()).map((manifest) => [manifest.id, manifest]))
	for (const app of await store.catalog()) {
		const current = installed.get(app.id)
		if (!current || (current.hash === app.hash && current.baseUrl === app.baseUrl)) continue
		await installApp(kernel, store, app)
	}
}
