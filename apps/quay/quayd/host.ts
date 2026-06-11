// Slice 5: the trusted host. quayd mounts a native-FS Volume under
// ~/Library/Application Support/quay/volume, builds the kernel over it, and seeds
// the built-in catalog (Code + Finder). The Volume's `/applications` is the
// canonical, syncable store — apps live here, not in the macOS `.app`s (Slice 6
// projects them out). Reducers run in a worker_thread sandbox from Slice 8, and
// real capabilities arrive in Slice 9 — until then the sandbox is a stub and the
// capability seam is absent (commands "unavailable", subscriptions inert), which
// is all seeding + listing exercise.

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { reconcileBuiltins } from '@justfiles/app/builtins'
import { type GetSandbox, type Kernel, kernel } from '@justfiles/app/runtime'
import { type Volume, volume } from '@justfiles/fs'
import { nativeStorage } from '@justfiles/fs/storage/fs'
import { builtinCatalog, readBuiltin } from './builtins.ts'

export interface Host {
	fs: Volume
	kernel: Kernel
}

// Never invoked in Slice 5: seeding writes bundles + lists manifests, and an
// absent capability seam makes subscription warming a no-op, so no reducer runs.
const stubSandbox: GetSandbox = async () => ({
	async run(): Promise<never> {
		throw new Error('quayd: reducers run from Slice 8 (nodeSandbox)')
	}
})

export async function createHost(): Promise<Host> {
	const root = join(homedir(), 'Library', 'Application Support', 'quay', 'volume')
	await mkdir(root, { recursive: true })
	const fs = volume(await nativeStorage(root))
	const k = kernel({ fs, sandbox: stubSandbox, clock: {} })
	await reconcileBuiltins(k, fs, builtinCatalog, readBuiltin)
	return { fs, kernel: k }
}
