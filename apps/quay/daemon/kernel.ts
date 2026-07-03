import { reconcileBuiltins } from '@justfiles/app/builtins'
import { capabilityRegistry } from '@justfiles/app/capabilities'
import {
	accountsCapabilities,
	type ProviderRegistry
} from '@justfiles/app/capabilities/accounts/host'
import { devkitCapability, type Runner } from '@justfiles/app/capabilities/devkit/host'
import { notifyHost } from '@justfiles/app/capabilities/notify/host'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import { appBundleFromMemory, type Kernel, kernel } from '@justfiles/app/runtime'
import type { Volume } from '@justfiles/fs'
import { builtinSource } from './builtins'
import { chatgptProvider } from './chatgpt'
import { getVolume } from './fs'
import { googleProvider } from './google/provider'
import { notificationChannel } from './notify'
import { sandboxes } from './sandbox'
import { toolchain } from './toolchain'

let kernelOnce: Promise<Kernel> | undefined

const systemAllowlist = ['app.frieren.files']

const providers: ProviderRegistry = new Map([
	[chatgptProvider.id, chatgptProvider],
	[googleProvider.id, googleProvider]
])

export function getKernel(): Promise<Kernel> {
	kernelOnce ??= getVolume().then(buildKernel)
	return kernelOnce
}

// Build the kernel over a given Volume: the capability registry (volume/devkit/accounts/
// email/calendar/ai/notify), the reducer sandbox pool, and the seeded builtin catalog.
// `getKernel` memoises this over the process Volume; tests build a throwaway kernel over a
// temp Volume (so they never touch the real support tree or share the daemon's singleton).
export async function buildKernel(fs: Volume): Promise<Kernel> {
	const { ai, email, calendar, accounts } = accountsCapabilities(providers, fs, {
		firstParty: ['app.frieren.settings']
	})

	const k = kernel({
		fs,
		sandbox: sandboxes.get,
		capabilities: capabilityRegistry({
			volume: volumeCapability(fs, { systemAllowlist }),
			devkit: (k) => {
				// Compile + typecheck run in a warm worker thread (see ./toolchain.ts),
				// not on the daemon's event loop — so tsc's multi-second synchronous
				// pass never freezes UI requests or app sockets. The client presents the
				// same `(input, runtime)` / `(input, types, paths)` backend signatures
				// the factory expects, so this is a drop-in for the in-process backends.
				const tc = toolchain()
				return devkitCapability({
					fs,
					kernel: k,
					compile: tc.compile,
					typecheck: tc.typecheck,
					runner: quayRunner(fs, k),
					overwrite: true
				})
			},
			accounts,
			email,
			calendar,
			ai,
			// Sandboxed apps reach the host's notification channel here; the kernel stamps
			// `source = appId` so a banner routes back to the app that raised it.
			notify: notifyHost(notificationChannel)
		}),
		clock: {}
	})
	const builtins = await builtinSource()
	await reconcileBuiltins(k, fs, builtins.catalog, builtins.read)
	return k
}

function quayRunner(fs: Volume, kernel: Kernel): Runner {
	return {
		mount: async (draft, { previewId, reset }) => {
			// ⟳ Run/Restart: wipe persisted draft state for a clean boot.
			if (reset) await fs.rm(`/state/${previewId}.json`, { force: true })
			await kernel.install(
				appBundleFromMemory({
					id: previewId,
					name: draft.manifest.name,
					app: draft.app,
					gui: draft.gui
				})
			)
			return { kind: 'url', src: `/app/${encodeURIComponent(previewId)}` }
		},
		stop: async ({ previewId }) => {
			await kernel.uninstall(previewId).catch(() => {})
		}
	}
}
