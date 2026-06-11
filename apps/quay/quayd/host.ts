// The trusted host. quayd mounts a native-FS Volume under
// ~/Library/Application Support/quay/volume, builds the kernel over it, and seeds
// the built-in catalog (Code + Finder + Counter). The Volume's `/applications` is
// the canonical, syncable store — apps live here, not in the macOS `.app`s (Slice 6
// projects them out). Reducers run in a worker_thread sandbox (Slice 7); real
// capabilities arrive in Slice 9 — until then the capability seam is absent
// (capability-using apps degrade, subscriptions inert), so a no-capability app
// (Counter) is the clean end-to-end target for the berth round-trip.

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { reconcileBuiltins } from '@justfiles/app/builtins'
import { type Kernel, kernel } from '@justfiles/app/runtime'
import { type Volume, volume } from '@justfiles/fs'
import { nativeStorage } from '@justfiles/fs/storage/fs'
import { builtinCatalog, readBuiltin } from './builtins.ts'
import { nodeSandbox } from './nodeSandbox.ts'

export interface Host {
	fs: Volume
	kernel: Kernel
}

export async function createHost(): Promise<Host> {
	const root = join(homedir(), 'Library', 'Application Support', 'quay', 'volume')
	await mkdir(root, { recursive: true })
	const fs = volume(await nativeStorage(root))
	const k = kernel({ fs, sandbox: nodeSandbox(), clock: {} })
	await reconcileBuiltins(k, fs, builtinCatalog, readBuiltin)
	return { fs, kernel: k }
}
