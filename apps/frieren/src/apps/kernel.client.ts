import { type Kernel, kernel } from '@justfiles/app'
import type { Volume } from '@justfiles/fs'
import { invokeClientCapability, streamClientCapability } from './capabilities.client'
import { browserSandbox } from './sandbox.worker'

export function createClientKernel(options: {
	fs: Volume
	getToken: () => Promise<string | null>
}): Kernel {
	return kernel({
		fs: options.fs,
		sandbox: browserSandbox(),
		clock: {},
		capabilityInvoke: (req) => invokeClientCapability(options.fs, options.getToken, req),
		capabilityStream: (req, emit) => streamClientCapability(options.fs, req, emit)
	})
}
