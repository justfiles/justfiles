// The trusted host. quayd mounts a native-FS Volume under
// ~/Library/Application Support/quay/volume, builds the kernel over it, and seeds
// the built-in catalog (Code + Finder + Counter). The Volume's `/applications` is
// the canonical, syncable store — apps live here, not in the macOS `.app`s (Slice 6
// projects them out). Reducers run in a worker_thread sandbox (Slice 7).
//
// Capabilities run in-process (Slice 9): one `capabilityRegistry` of local units
// the kernel owns. Today that's `volume` over the same native-FS Volume — the
// kernel attaches each app's DECLARED scopes (Finder's `system`, others' per-app
// `/data/<id>`), so a reducer reaches real files without ever holding the
// capability itself. (`ai`/`devkit` are added when a built-in needs them — the
// Slice 10 agent calls the LLM directly, not through a reducer capability.)

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { reconcileBuiltins } from '@justfiles/app/builtins'
import { capabilityRegistry } from '@justfiles/app/capabilities'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import { type Kernel, kernel } from '@justfiles/app/runtime'
import { type Volume, volume } from '@justfiles/fs'
import { nativeStorage } from '@justfiles/fs/storage/fs'
import { builtinCatalog, readBuiltin } from './builtins.ts'
import { type NodeSandbox, nodeSandbox } from './nodeSandbox.ts'

// Apps allowed to bind the `system` scope (the user's whole Volume) rather than a
// per-app `/data/<id>` chroot. Finder is the file browser, so it's the one
// built-in that needs it — mirroring frieren and the desktop sibling.
const systemAllowlist = ['app.frieren.finder']

export interface Host {
	fs: Volume
	kernel: Kernel
	// The reducer-worker pool; its `retain`/`release` drive idle eviction off the
	// berth (window) lifecycle (Slice 8).
	sandbox: NodeSandbox
}

export async function createHost(
	root = join(homedir(), 'Library', 'Application Support', 'quay', 'volume')
): Promise<Host> {
	await mkdir(root, { recursive: true })
	const fs = volume(await nativeStorage(root))
	const sandbox = nodeSandbox()
	const capabilities = capabilityRegistry({ volume: volumeCapability(fs, { systemAllowlist }) })
	const k = kernel({ fs, sandbox: sandbox.get, capabilities, clock: {} })
	await reconcileBuiltins(k, fs, builtinCatalog, readBuiltin)
	return { fs, kernel: k, sandbox }
}
