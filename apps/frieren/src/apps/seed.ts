import type { Kernel } from '@justfiles/app'
import { materialise, reconcile } from '@justfiles/app/appstore'
import type { Volume } from '@justfiles/fs'
import { httpAppStore } from '../../shared/appstore'

// A local-only marker recording that THIS replica has already run its one-time
// built-in seed. Under `/.state/**` so it never crosses the wire (it is a
// per-replica fact, not synced account state — a synced marker would reintroduce
// the two-authority fork this change removes; see docs/app-materialization.md).
const MATERIALISED_MARKER = '/.state/materialised'

// The CLIENT is the single materialiser of built-in apps (R1/R2). Seed once per
// replica, then keep installed apps up to date on every boot:
//
//   - materialise (seed) runs AT MOST ONCE per replica, and only when the volume
//     is still empty of apps. A synced profile waits for the first bootstrap
//     first (`waitForBootstrap`) so a returning account that already has apps
//     down doesn't get re-seeded, and a built-in the user deleted stays gone
//     (R5). A genuinely new account (empty after bootstrap) gets the defaults.
//   - reconcile (update) runs every boot: monotonic, idempotent, applied via
//     this client kernel and synced up. The server never materialises.
//
// The marker gates seeding so it can't re-run — even for a returning user whose
// pre-marker volume already has apps (migration: not empty ⇒ no re-seed).
export async function seedBuiltins(
	kernel: Kernel,
	fs: Volume,
	opts: { waitForBootstrap?: () => Promise<void> } = {}
): Promise<void> {
	const store = await httpAppStore((path) => fetch(path))
	if (!store) return
	if (!(await fs.exists(MATERIALISED_MARKER))) {
		// R2 barrier: on a synced profile, block on the first bootstrap ("nobody
		// moves") so the emptiness check below reflects the account's real state.
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
