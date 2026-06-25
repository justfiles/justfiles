import { type Kernel, kernel } from '@justfiles/app/runtime'
import { capabilities } from './caps'
import { getVolume } from './fs'
import { getSandbox } from './sandbox'

let kernelOnce: Promise<Kernel> | undefined

export async function getKernel() {
	kernelOnce ??= (async () => {
		const fs = await getVolume()
		return kernel({ fs, sandbox: getSandbox, capabilities, clock: {} })
	})()
	return kernelOnce
}
