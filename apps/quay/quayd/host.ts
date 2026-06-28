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
// capabilities it backs. The `ai` USE facet is served over that store; the agent's
// own LLM runtime borrows the ai-enabled account through the same store (the store
// itself stays internal to @justfiles/app — the host only ever passes a Volume).

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { reconcileBuiltins } from '@justfiles/app/builtins'
import { capabilityRegistry } from '@justfiles/app/capabilities'
import {
	accountsCapabilities,
	type ProviderRegistry
} from '@justfiles/app/capabilities/accounts/host'
import type { Channel } from '@justfiles/app/capabilities/notify'
import { notifyHost } from '@justfiles/app/capabilities/notify/host'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import { type Kernel, kernel } from '@justfiles/app/runtime'
import { type Volume, volume } from '@justfiles/fs'
import { nativeStorage } from '@justfiles/fs/storage/fs'
import { builtinSource } from './builtins.ts'
import { chatgptProvider } from './chatgpt.ts'
import { devkitCapability } from './devkit.ts'
import { googleProvider } from './google/provider.ts'
import { type NodeSandbox, nodeSandbox } from './nodeSandbox.ts'

// Apps allowed to bind the `system` scope (the user's whole Volume) rather than a
// per-app `/data/<id>` chroot. Files is the file browser, so it's the one
// built-in that needs it — mirroring frieren.
const systemAllowlist = ['app.frieren.files']

// Apps allowed to reach the `accounts` admin facet (connect/toggle providers).
// Settings is the only first-party app that needs it.
const accountsFirstParty = ['app.frieren.settings']

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
	onInstalled: () => void | Promise<void> = () => {},
	// The host's notification channel — a sandboxed app's `notify` calls land here
	// (source kernel-stamped). Bound deferred to `served.notify` in main.ts once the
	// server is up; a no-op default keeps tests host-only.
	channel: Channel = () => {},
	previewUrl: (previewId: string) => string = (id) => `/app/${encodeURIComponent(id)}`
): Promise<Host> {
	await mkdir(root, { recursive: true })
	const fs = volume(await nativeStorage(root))
	// Each app bundle is self-contained — the reducer compile bundles its SDK into `app.js` —
	// so the sandbox just spawns a worker from the bundle; no SDK injection at spawn.
	const sandbox = nodeSandbox()
	// The connectable providers: ChatGPT (OAuth → `ai`) and Google (OAuth → `email`
	// + `calendar` from ONE account). The store persists connected accounts on the
	// Volume; the served use facets and the agent read it.
	const providers: ProviderRegistry = new Map([
		[chatgptProvider.id, chatgptProvider],
		[googleProvider.id, googleProvider]
	])
	// One factory builds the credential-bearing store internally from the Volume and
	// returns the wired capabilities — quay holds the Volume, never the store. The
	// USE facets (`email`/`calendar` fan out across every enabled account, `ai`
	// resolves the ai-enabled one); the `accounts` admin facet (gated to Settings)
	// connects providers and toggles what they back. The agent's own LLM runtime
	// borrows the ai account separately via `resolveAgentBackend` (resolveAiAccount).
	const { ai, email, calendar, accounts } = accountsCapabilities(providers, fs, {
		firstParty: accountsFirstParty
	})
	// Only `devkit` needs the kernel `install` writes into: it's a per-entry factory
	// the kernel resolves with ITSELF, so devkit gets the exact instance it lives in
	// — no forward-ref, and the rest of the registry stays plain.
	const k = kernel({
		fs,
		sandbox: sandbox.get,
		clock: {},
		capabilities: capabilityRegistry({
			volume: volumeCapability(fs, { systemAllowlist }),
			devkit: (self) => devkitCapability(fs, self, onInstalled, previewUrl),
			ai,
			email,
			calendar,
			accounts,
			// Sandboxed apps reach the host's notification channel here; the kernel stamps
			// `source = appId` so a banner routes back to the app that raised it.
			notify: notifyHost(channel)
		})
	})
	const builtins = await builtinSource()
	await reconcileBuiltins(k, fs, builtins.catalog, builtins.read)
	return { fs, kernel: k, sandbox }
}
