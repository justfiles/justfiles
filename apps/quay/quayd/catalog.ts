import type { AppManifest, Kernel } from '@justfiles/app/runtime'
import type { AppInfo } from './server.ts'

// Catalog shape the native launcher consumes. The kernel stores icon paths inside
// each installed bundle; the launcher needs browser-independent image bytes, so
// expose icons as data URLs on the websocket catalog.
export async function launcherCatalog(kernel: Pick<Kernel, 'list' | 'app'>): Promise<AppInfo[]> {
	return Promise.all(
		(await kernel.list())
			.filter((app) => !app.id.startsWith('preview.'))
			.map(async (app) => ({
				id: app.id,
				name: app.name,
				glyph: app.name.slice(0, 1).toUpperCase(),
				icon: await iconDataUrl(kernel, app)
			}))
	)
}

async function iconDataUrl(
	kernel: Pick<Kernel, 'app'>,
	manifest: AppManifest
): Promise<string | undefined> {
	if (!manifest.icon) return undefined
	try {
		const bytes = await (await kernel.app(manifest.id)).read(manifest.icon)
		const text = new TextDecoder().decode(bytes).trim()
		if (text.startsWith('data:image/')) return text
		return `data:${mime(manifest.icon, bytes)};base64,${Buffer.from(bytes).toString('base64')}`
	} catch {
		return undefined
	}
}

function mime(path: string, bytes: Uint8Array): string {
	const p = path.toLowerCase()
	if (p.endsWith('.svg') || new TextDecoder().decode(bytes.slice(0, 128)).includes('<svg'))
		return 'image/svg+xml'
	if (p.endsWith('.png') || (bytes[0] === 0x89 && bytes[1] === 0x50)) return 'image/png'
	if (p.endsWith('.jpg') || p.endsWith('.jpeg') || (bytes[0] === 0xff && bytes[1] === 0xd8))
		return 'image/jpeg'
	return 'application/octet-stream'
}
