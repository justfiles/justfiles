import { type Kernel, kernel } from '@justfiles/app'
import type { Volume } from '@justfiles/fs'
import { clientCapabilities } from './capabilities.client'
import { notifyCatalog } from './host'
import { browserSandbox } from './sandbox.worker'

export function createClientKernel(options: {
	fs: Volume
	getToken: () => Promise<string | null>
}): Kernel {
	const k = kernel({
		fs: options.fs,
		sandbox: browserSandbox(),
		clock: {},
		capabilities: clientCapabilities(options.fs, options.getToken)
	})
	// A devkit install/uninstall mutates this kernel's catalog; the OS launcher
	// caches the list, so re-notify it. Subscribed here (post-construction) rather
	// than inside the capability factory, which must not touch the kernel yet.
	k.subscribe((event) => {
		if (event.type === 'app.installed' || event.type === 'app.uninstalled') notifyCatalog()
	})
	return k
}
