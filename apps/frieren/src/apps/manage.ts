import { bundleFromZip, type Kernel } from '@justfiles/app'
import { httpAppStore } from '../../shared/appstore'

export async function installZipApp(kernel: Kernel, zip: Uint8Array): Promise<string> {
	return kernel.install(bundleFromZip(zip))
}

// Built-in apps can't be uninstalled: reconcile reinstalls every built-in on each
// launch, so removing one is pointless — it would just reappear. Guard here so
// the user can't. User apps uninstall normally.
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
