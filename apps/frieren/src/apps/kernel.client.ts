import { type Kernel, kernel } from '@justfiles/app'
import type { Volume } from '@justfiles/fs'
import { invokeClientCapability } from './capabilities.client'
import { browserSandbox } from './sandbox.worker'

export function createClientKernel(options: {
	fs: Volume
	getToken: () => Promise<string | null>
}): Kernel {
	return kernel({
		fs: options.fs,
		sandbox: browserSandbox({
			capabilities: (req) => invokeClientCapability(options.fs, options.getToken, req)
		}),
		clock: {}
	})
}
