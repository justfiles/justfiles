import { bundleFromZip, type Kernel } from '@justfiles/app'
import { httpAppStore } from '../../shared/appstore'

export async function installZipApp(kernel: Kernel, zip: Uint8Array): Promise<string> {
	return kernel.install(bundleFromZip(zip))
}

// Built-in apps are guarded from uninstall (conservative for now); user apps
// uninstall normally.
export async function uninstallLocalApp(kernel: Kernel, id: string): Promise<void> {
	if (await isBuiltin(id)) throw new Error(`built-in apps cannot be uninstalled: ${id}`)
	await kernel.uninstall(id)
}

async function isBuiltin(id: string): Promise<boolean> {
	try {
		const store = await httpAppStore((path) => fetch(path))
		if (store) return (await store.builtins()).some((app) => app.id === id)
	} catch {}
	return id.startsWith('app.frieren.')
}
