// The trusted host. quayd mounts a native-FS Volume under
// ~/Library/Application Support/quay/volume, builds the kernel over it, and seeds
// the built-in catalog (Code + Files + Counter). The Volume's `/applications` is
// the canonical, syncable store — apps live here, not in the macOS `.app`s (Slice 6
// projects them out). Reducers run in a worker_thread sandbox (Slice 7).
//
// Capabilities run in-process: one `capabilityRegistry` of local units the kernel
// owns. `volume` (Slice 9) spans the same native-FS Volume — the kernel attaches each
// app's DECLARED scopes (Files' `system`, others' per-app `/data/<id>`), so a
// reducer reaches real files without ever holding the capability itself. `devkit`
// (Slice 11) is the build pipeline Code uses to compile + install the apps you build:
// `install` writes the new bundle into `/applications` and fires `onInstalled`, which
// the daemon turns into a `.app` materialisation + launcher re-list. The `ai`
// capability's ADMIN facet lets the Settings app sign the user in to ChatGPT and pick
// a model; the credential lands on the Volume and the agent reads it (the agent still
// calls the LLM directly, so quay serves no `ai` USE facet).

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { reconcileBuiltins } from '@justfiles/app/builtins'
import { capabilityRegistry } from '@justfiles/app/capabilities'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import { type Kernel, kernel } from '@justfiles/app/runtime'
import { type Volume, volume } from '@justfiles/fs'
import { nativeStorage } from '@justfiles/fs/storage/fs'
import { aiAdminCapability } from './aiAdmin.ts'
import { builtinCatalog, readBuiltin } from './builtins.ts'
import { devkitCapability } from './devkit.ts'
import { type NodeSandbox, nodeSandbox } from './nodeSandbox.ts'

// Apps allowed to bind the `system` scope (the user's whole Volume) rather than a
// per-app `/data/<id>` chroot. Files is the file browser, so it's the one
// built-in that needs it — mirroring frieren and the desktop sibling.
const systemAllowlist = ['app.frieren.files']

// Apps allowed to reach the `ai` capability's ADMIN facet (AI sign-in / model
// pick). Settings is the only first-party app that needs it.
const aiAdminAllowlist = ['app.frieren.settings']

export interface Host {
	fs: Volume
	kernel: Kernel
	// The reducer-worker pool; its `retain`/`release` drive idle eviction off the
	// berth (window) lifecycle (Slice 8).
	sandbox: NodeSandbox
}

export async function createHost(
	root = join(homedir(), 'Library', 'Application Support', 'quay', 'volume'),
	// Fired after `devkit.install` writes a new app to `/applications`; the daemon
	// (main.ts) re-materialises the `.app` projection and pushes the launcher a fresh
	// catalog. Defaults to a no-op so tests can construct a host without the daemon.
	onInstalled: () => void | Promise<void> = () => {}
): Promise<Host> {
	await mkdir(root, { recursive: true })
	const fs = volume(await nativeStorage(root))
	const sandbox = nodeSandbox()
	// `devkit` needs the kernel `install` writes into, but the kernel is built with
	// this registry already attached — so it's handed in lazily.
	let k: Kernel
	const capabilities = capabilityRegistry({
		volume: volumeCapability(fs, { systemAllowlist }),
		devkit: devkitCapability(fs, () => k, onInstalled),
		// AI setup: the admin facet of `ai`. Settings signs the user in to ChatGPT and
		// picks a model; the credential lands on the Volume (connections.ts) and the
		// agent reads it. Gated to first-party apps so only Settings can reach it.
		ai: aiAdminCapability(fs, { firstParty: aiAdminAllowlist })
	})
	k = kernel({ fs, sandbox: sandbox.get, capabilities, clock: {} })
	await reconcileBuiltins(k, fs, builtinCatalog, readBuiltin)
	return { fs, kernel: k, sandbox }
}
