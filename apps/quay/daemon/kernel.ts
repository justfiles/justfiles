import { type Kernel, kernel, appBundleFromMemory } from '@justfiles/app/runtime'
import { getVolume } from './fs'
import { getSandbox } from './sandbox'
import { capabilityRegistry } from '@justfiles/app/capabilities'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import { devkitCapability, type Runner } from '@justfiles/app/capabilities/devkit/host'
import { bunCompile } from '@justfiles/app/toolchain/bun'
import type { Volume } from '@justfiles/fs'
import { tsTypecheck } from '@justfiles/app/toolchain/typescript'
import * as ts from 'typescript'

let kernelOnce: Promise<Kernel> | undefined

const systemAllowlist = ['app.frieren.files']

export async function getKernel(): Promise<Kernel> {
	kernelOnce ??= (async () => {
		const fs = await getVolume()
		return kernel({
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
		},
		stop: async ({ previewId }) => {
			await kernel.uninstall(previewId).catch(() => {})
		}
	}
}
