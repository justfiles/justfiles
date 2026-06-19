import type { Kernel } from '@justfiles/app/runtime'
import type { AppInfo } from './server.ts'

// Catalog shape the native launcher consumes. Icons deliberately stay out of this
// websocket payload: the launcher reads the materialised .app icon from macOS.
export async function launcherCatalog(kernel: Pick<Kernel, 'list'>): Promise<AppInfo[]> {
	return (await kernel.list())
		.filter((app) => !app.id.startsWith('preview.'))
		.map((app) => ({
			id: app.id,
			name: app.name,
			glyph: app.name.slice(0, 1).toUpperCase()
		}))
}
