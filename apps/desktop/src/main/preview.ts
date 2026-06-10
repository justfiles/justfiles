import { join } from 'node:path'
import type { DraftBuild } from '@justfiles/app/devkit'
import { appBundleFromMemory, type Kernel } from '@justfiles/app/runtime'
import { type BrowserWindow, type Rectangle, WebContentsView } from 'electron'

type PreviewRecord = {
	ownerAppId: string
	view: WebContentsView
	attachedTo?: BrowserWindow
}

type PreviewManagerOptions = {
	getKernel: () => Kernel
	preload: string
	load: (view: WebContentsView, appId: string) => void
}

export function createPreviewManager({ getKernel, preload, load }: PreviewManagerOptions) {
	const slots = new Map<string, { win: BrowserWindow; rect: Rectangle }>()
	const previews = new Map<string, PreviewRecord>()

	return { setSlot, run, stop, menu, selectMenu }

	function setSlot(ownerAppId: string, win: BrowserWindow, rect: Rectangle): void {
		slots.set(ownerAppId, { win, rect })
		for (const preview of previews.values()) {
			if (preview.ownerAppId === ownerAppId) attach(preview)
		}
	}

	async function run(
		ownerAppId: string,
		slug: string,
		draft: DraftBuild,
		_reset?: boolean
	): Promise<{ previewId: string; diagnostics: string[] }> {
		const previewId = `preview.${slug}`
		if (draft.diagnostics.length === 0 && draft.app && draft.gui) {
			const kernel = getKernel()
			await kernel.uninstall(previewId).catch(() => {})
			await kernel.install(
				appBundleFromMemory({
					id: previewId,
					name: draft.manifest.name,
					description: draft.manifest.description,
					version: draft.manifest.version,
					app: draft.app,
					gui: draft.gui,
					...(draft.icon ? { icon: 'icon', assets: { icon: draft.icon } } : {})
				})
			)
			let preview = previews.get(previewId)
			if (!preview) {
				preview = {
					ownerAppId,
					view: new WebContentsView({ webPreferences: { preload, sandbox: false } })
				}
				previews.set(previewId, preview)
			}
			load(preview.view, previewId)
			attach(preview)
		}
		return { previewId, diagnostics: draft.diagnostics }
	}

	async function stop({ previewId }: { previewId: string }): Promise<void> {
		const preview = previews.get(previewId)
		if (preview?.attachedTo) preview.attachedTo.contentView.removeChildView(preview.view)
		preview?.view.webContents.close()
		previews.delete(previewId)
		await getKernel()
			.uninstall(previewId)
			.catch(() => {})
	}

	async function menu(): Promise<[]> {
		return []
	}

	async function selectMenu(): Promise<void> {}

	function attach(preview: PreviewRecord): void {
		const slot = slots.get(preview.ownerAppId)
		if (!slot || slot.rect.width < 1 || slot.rect.height < 1) return
		if (preview.attachedTo && preview.attachedTo !== slot.win) {
			preview.attachedTo.contentView.removeChildView(preview.view)
		}
		slot.win.contentView.addChildView(preview.view)
		preview.attachedTo = slot.win
		preview.view.setBounds({
			x: Math.round(slot.rect.x),
			y: Math.round(slot.rect.y),
			width: Math.round(slot.rect.width),
			height: Math.round(slot.rect.height)
		})
	}
}

export function preloadPath(dirname: string): string {
	return join(dirname, '../preload/index.js')
}
