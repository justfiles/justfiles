import { reconcileBuiltins } from '@justfiles/app/builtins'
import { capabilityRegistry } from '@justfiles/app/capabilities'
import { devkitCapability, type Runner } from '@justfiles/app/capabilities/devkit/host'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import { appBundleFromMemory, type Kernel, kernel } from '@justfiles/app/runtime'
import { bunCompile } from '@justfiles/app/toolchain/bun'
import { tsTypecheck } from '@justfiles/app/toolchain/typescript'
import type { Volume } from '@justfiles/fs'
import * as ts from 'typescript'
import { builtinSource } from '../quayd/builtins'
import { getVolume } from './fs'
import { getSandbox } from './sandbox'

let kernelOnce: Promise<Kernel> | undefined

const systemAllowlist = ['app.frieren.files']

export async function getKernel(): Promise<Kernel> {
	kernelOnce ??= (async () => {
		const fs = await getVolume()
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
					})
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
