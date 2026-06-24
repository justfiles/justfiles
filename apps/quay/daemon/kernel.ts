import { kernel, type Kernel } from '@justfiles/app/runtime'
import { getSandbox } from './sandbox'
import { capabilities } from './caps'
import type { Volume } from '@justfiles/fs'

let kernelOnce: Promise<Kernel> | undefined

export async function getKernel(fs: Volume) {
	kernelOnce ??= (async () => {
		return kernel({ fs, sandbox: getSandbox, capabilities, clock: {} })
	})()
	return kernelOnce
}
