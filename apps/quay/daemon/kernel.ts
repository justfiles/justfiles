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
import { bunCompile } from '@justfiles/app/toolchain/bun'
import { tsTypecheck } from '@justfiles/app/toolchain/typescript'
import type { Volume } from '@justfiles/fs'
import * as ts from 'typescript'
import { builtinSource } from '../quayd/builtins'
import { chatgptProvider } from '../quayd/chatgpt'
import { googleProvider } from '../quayd/google/provider'
import { getVolume } from './fs'
import { notificationChannel } from './notify'
import { getSandbox } from './sandbox'

let kernelOnce: Promise<Kernel> | undefined

const systemAllowlist = ['app.frieren.files']

const providers: ProviderRegistry = new Map([
	[chatgptProvider.id, chatgptProvider],
	[googleProvider.id, googleProvider]
])

export async function getKernel(): Promise<Kernel> {
	kernelOnce ??= (async () => {
		const fs = await getVolume()

		const { ai, email, calendar, accounts } = accountsCapabilities(providers, fs, {
			firstParty: ['app.frieren.settings']
		})

		const k = kernel({
			fs,
			sandbox: getSandbox,
			capabilities: capabilityRegistry({
				volume: volumeCapability(fs, { systemAllowlist }),
				devkit: (k) =>
					devkitCapability({
						fs,
						kernel: k,
						compile: bunCompile,
						typecheck: async (input, types, paths) => tsTypecheck(input, ts, types, paths),
						runner: quayRunner(fs, k),
						overwrite: true
					}),
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
	})()
	return kernelOnce
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
