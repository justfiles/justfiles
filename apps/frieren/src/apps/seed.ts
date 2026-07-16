import type { Kernel } from '@justfiles/app'
import { materialise, reconcile } from '@justfiles/app/appstore'
import type { Volume } from '@justfiles/fs'
import { bootAppStore } from '../../shared/appstore'

// The client is the single materialiser of built-in apps. On every boot it makes
// the volume match the release: `materialise` installs any built-in that's
// missing — so a newly-shipped built-in lands for existing users, not just
// empty-volume first boots — and `reconcile` updates the ones already installed.
// Both are idempotent (materialise only installs what's absent; reconcile is
// monotonic), so re-running each boot is cheap when nothing changed. Applied via
// this client kernel and synced up — the server never materialises.
export async function seedBuiltins(
	kernel: Kernel,
	fs: Volume,
	opts: { waitForBootstrap?: () => Promise<void> } = {}
): Promise<void> {
	const store = await bootAppStore((path) => fetch(path))
	if (!store) return
	// A synced profile blocks on the first bootstrap so a built-in that's about to
	// sync down isn't redundantly installed (and a fresh replica doesn't seed the
	// whole set before its apps arrive). Local-only profiles have no bootstrap.
	await opts.waitForBootstrap?.()
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
