import { bundleFromZip, type Kernel } from '@justfiles/app'
import { type Catalog, disabledMarker } from '@justfiles/app/builtins'
import { CATALOG_PATH } from '../../shared/appstore'
import type { Volume } from '../fs'

const enc = new TextEncoder()

export async function installZipApp(kernel: Kernel, fs: Volume, zip: Uint8Array): Promise<string> {
	const id = await kernel.install(bundleFromZip(zip))
	await fs.rm(disabledMarker(id), { force: true })
	return id
}

export async function uninstallLocalApp(kernel: Kernel, fs: Volume, id: string): Promise<void> {
	if (await isBuiltin(id)) {
		await fs.mkdir('/system/apps/disabled', { recursive: true })
		await fs.writeFile(disabledMarker(id), enc.encode(JSON.stringify({ disabledAt: Date.now() })))
		await fs.rm(appRoot(id), { recursive: true, force: true })
		return
	}
	await kernel.uninstall(id)
}

async function isBuiltin(id: string): Promise<boolean> {
	try {
		const res = await fetch(CATALOG_PATH)
		if (res.ok) {
			const catalog = (await res.json()) as Catalog
			return catalog.apps.some((app) => app.id === id)
		}
	} catch {}
	return id.startsWith('app.frieren.')
}

function appRoot(id: string): string {
	if (!/^[A-Za-z0-9]+([.-][A-Za-z0-9]+)*$/.test(id)) throw new Error(`invalid app id: ${id}`)
	return `/applications/${id}`
}
