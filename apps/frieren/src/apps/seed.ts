import type { Kernel } from '@justfiles/app'
import { materialise, reconcile } from '@justfiles/app/appstore'
import type { Volume } from '@justfiles/fs'
import { httpAppStore } from '../../shared/appstore'

// Per-replica marker: this replica has already run its one-time built-in seed.
// Under `/.state/**` so it never crosses the wire — a synced marker would
// reintroduce the two-authority fork this change removes.
const MATERIALISED_MARKER = '/.state/materialised'

// The client is the single materialiser of built-in apps: seed once per replica,
// then reconcile installed apps on every boot. `materialise` runs at most once and
// only into an empty volume; the marker keeps it from re-running (a returning user
// with a pre-marker non-empty volume isn't re-seeded). `reconcile` is monotonic +
// idempotent, applied via this client kernel and synced up — the server never
// materialises.
export async function seedBuiltins(
	kernel: Kernel,
	fs: Volume,
	opts: { waitForBootstrap?: () => Promise<void> } = {}
): Promise<void> {
	const store = await httpAppStore((path) => fetch(path))
	if (!store) return
	if (!(await fs.exists(MATERIALISED_MARKER))) {
		// On a synced profile, block on the first bootstrap so the emptiness check
		// below reflects the account's real state.
		await opts.waitForBootstrap?.()
		if ((await kernel.list()).length === 0) await materialise(kernel, store)
		await mark(fs)
	}
	await reconcile(kernel, fs, store)
}

async function mark(fs: Volume): Promise<void> {
	await fs.mkdir('/.state', { recursive: true })
	await fs.writeFile(MATERIALISED_MARKER, new Uint8Array([49]))
}

// Re-run the update pass when the `/applications` tree changes — a synced-down
// bundle or a local install. Monotonic + idempotent, so the launcher's structural
// watch can fire it freely. No-ops offline / before any catalog exists.
export async function reconcileInstalled(kernel: Kernel, fs: Volume): Promise<void> {
	const store = await httpAppStore((path) => fetch(path))
	if (store) await reconcile(kernel, fs, store)
}
