// The trusted host. quayd mounts a native-FS Volume under
// ~/Library/Application Support/quay/volume, builds the kernel over it, and seeds
// the built-in catalog (Code + Files + Counter + Settings). The Volume's
// `/applications` is the canonical, syncable store — apps live here, not in the
// macOS `.app`s (Slice 6 projects them out). Reducers run in a worker_thread
// sandbox (Slice 7).
//
// Capabilities run in-process: one `capabilityRegistry` of local units the kernel
// owns. `volume` (Slice 9) spans the same native-FS Volume — the kernel attaches each
// app's DECLARED scopes (Files' `system`, others' per-app `/data/<id>`), so a
// reducer reaches real files without ever holding the capability itself. `devkit`
// (Slice 11) is the build pipeline Code uses to compile + install the apps you build.
// The `accounts` capability is the macOS "Internet Accounts" model: Settings (first-
// party, gated) connects a provider — here ChatGPT via OAuth — and toggles which
// capabilities it backs. The `ai` USE facet is served over that store, and the agent
// reads the same store directly for its own LLM runtime.

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { reconcileBuiltins } from '@justfiles/app/builtins'
import { capabilityRegistry } from '@justfiles/app/capabilities'
import {
	type AccountsStore,
	accountsAdminHost,
	aiHost,
	calendarHost,
	emailHost,
	type ProviderRegistry
} from '@justfiles/app/capabilities/accounts/host'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import { type Kernel, kernel } from '@justfiles/app/runtime'
import { type Volume, volume } from '@justfiles/fs'
import { nativeStorage } from '@justfiles/fs/storage/fs'
import { volumeAccountsStore } from './accounts.ts'
import { builtinCatalog, readBuiltin } from './builtins.ts'
import { chatgptProvider } from './chatgpt.ts'
import { devkitCapability } from './devkit.ts'
import { googleProvider } from './google/provider.ts'
import { type NodeSandbox, nodeSandbox } from './nodeSandbox.ts'

// Apps allowed to bind the `system` scope (the user's whole Volume) rather than a
// per-app `/data/<id>` chroot. Files is the file browser, so it's the one
// built-in that needs it — mirroring frieren and the desktop sibling.
const systemAllowlist = ['app.frieren.files']

// Apps allowed to reach the `accounts` admin facet (connect/toggle providers).
// Settings is the only first-party app that needs it.
const accountsFirstParty = ['app.frieren.settings']

export interface Host {
	fs: Volume
	kernel: Kernel
	// The connected-accounts store, shared between the served `ai` use facet and the
	// agent's direct LLM runtime (resolveAi).
	accounts: AccountsStore
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
	// The connectable providers: ChatGPT (OAuth → `ai`) and Google (OAuth → `email`
	// + `calendar` from ONE account). The store persists connected accounts on the
	// Volume; the served use facets and the agent read it.
	const providers: ProviderRegistry = new Map([
		[chatgptProvider.id, chatgptProvider],
		[googleProvider.id, googleProvider]
	])
	const accounts = volumeAccountsStore(fs)
	// `devkit` needs the kernel `install` writes into, but the kernel is built with
	// this registry already attached — so it's handed in lazily.
	let k: Kernel
	const capabilities = capabilityRegistry({
		volume: volumeCapability(fs, { systemAllowlist }),
		devkit: devkitCapability(fs, () => k, onInstalled),
		// USE facets served over the connected accounts (`email`/`calendar` fan out
		// across every enabled account); `accounts` admin facet (gated to Settings)
		// connects providers and toggles what they back.
		ai: aiHost(providers, accounts),
		email: emailHost(providers, accounts),
		calendar: calendarHost(providers, accounts),
		accounts: accountsAdminHost(providers, accounts, { firstParty: accountsFirstParty })
	})
	k = kernel({ fs, sandbox: sandbox.get, capabilities, clock: {} })
	await reconcileBuiltins(k, fs, builtinCatalog, readBuiltin)
	return { fs, kernel: k, accounts, sandbox }
}
