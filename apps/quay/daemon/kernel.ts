import { type Kernel, kernel } from '@justfiles/app/runtime'
import type { Volume } from '@justfiles/fs'
import { capabilities } from './caps'
import { getSandbox } from './sandbox'

let kernelOnce: Promise<Kernel> | undefined

export async function getKernel(fs: Volume) {
	kernelOnce ??= (async () => {
		return kernel({ fs, sandbox: getSandbox, capabilities, clock: {} })
	})()
	return kernelOnce
}
