import { type Kernel, kernel } from '@justfiles/app'
import type { GetUser } from '@justfiles/app/capabilities/settings/host'
import type { Volume } from '@justfiles/fs'
import { clientCapabilities } from './capabilities.client'
import { notifyCatalog } from './host'
import { browserSandbox } from './sandbox.worker'

export function createClientKernel(options: {
	fs: Volume
	getToken: () => Promise<string | null>
	getUser?: GetUser
}): Kernel {
	const k = kernel({
		fs: options.fs,
		sandbox: browserSandbox(),
		clock: {},
		// A hosted app's payload is mounted with plain fetch. Built-ins are precached;
		// Runner's immutable release URLs use the service worker runtime cache.
		fetchAsset: async (url) => {
			const res = await fetch(url)
			if (!res.ok) throw new Error(`appstore: ${url} ${res.status}`)
			return new Uint8Array(await res.arrayBuffer())
		},
		capabilities: clientCapabilities(options.fs, options.getToken, options.getUser)
	})
	// A devkit install/uninstall mutates this kernel's catalog; the OS launcher
	// caches the list, so re-notify it. Subscribed here (post-construction) rather
	// than inside the capability factory, which must not touch the kernel yet.
	k.subscribe((event) => {
		if (event.type === 'app.installed' || event.type === 'app.uninstalled') notifyCatalog()
	})
	return k
}
