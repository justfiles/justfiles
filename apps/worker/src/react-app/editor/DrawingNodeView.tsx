import type { Node as PMNode } from 'prosemirror-model'
import type { NodeView } from 'prosemirror-view'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const Excalidraw = lazy(async () => {
	const [m] = await Promise.all([
		import('@excalidraw/excalidraw'),
		import('@excalidraw/excalidraw/index.css')
	])
	return { default: m.Excalidraw }
})

interface ExcalidrawAPI {
	getSceneElements: () => readonly unknown[]
	getAppState: () => Record<string, unknown>
	getFiles: () => Record<string, unknown>
}

interface DrawingEditorModalProps {
	drawingId: string | null
	resolveAssetUrl: (src: string | null) => Promise<string | null>
	readAssetBlob: (src: string | null) => Promise<Blob | null>
	uploadAsset: (file: File) => Promise<string>
	onSave: (id: string, previewUrl: string) => void
	onClose: () => void
}

interface OpenDrawingEditorArgs {
	id: string | null
	onSave: (id: string, previewUrl: string) => void
}

function parseEmbeddedScene(svgText: string): Record<string, unknown> | null {
	const match = svgText.match(/^<!-- excalidraw-scene: ([\s\S]*?) -->/)
	if (!match) return null
	try {
		const parsed = JSON.parse(match[1]) as {
			appState?: { collaborators?: Record<string, unknown> }
		} & Record<string, unknown>
		if (parsed.appState) {
			;(parsed.appState as { collaborators?: unknown }).collaborators = new Map(
				Object.entries(parsed.appState.collaborators ?? {})
			)
		}
		return parsed
	} catch {
		return null
	}
}

export function DrawingEditorModal({
	drawingId,
	resolveAssetUrl,
	readAssetBlob,
	uploadAsset,
	onSave,
	onClose
}: DrawingEditorModalProps) {
	const apiRef = useRef<ExcalidrawAPI | null>(null)
	const [initialData, setInitialData] = useState<Record<string, unknown> | null>(null)
	const [loading, setLoading] = useState(true)

	useEffect(() => {
		let cancelled = false

		async function loadInitialData() {
			setLoading(true)
			setInitialData(null)

			if (!drawingId) {
				if (!cancelled) setLoading(false)
				return
			}

			try {
				const src = await resolveAssetUrl(drawingId)
				if (!src) {
					if (!cancelled) setLoading(false)
					return
				}
				const blob = await readAssetBlob(drawingId)
				if (!blob) {
					if (!cancelled) setLoading(false)
					return
				}
				const svgText = await blob.text()
				if (!cancelled) setInitialData(parseEmbeddedScene(svgText))
			} catch {
				if (!cancelled) setInitialData(null)
			} finally {
				if (!cancelled) setLoading(false)
			}
		}

		loadInitialData()
		return () => {
			cancelled = true
		}
	}, [drawingId, readAssetBlob, resolveAssetUrl])

	const handleSave = useCallback(async () => {
		if (!apiRef.current) return

		try {
			const { exportToSvg } = await import('@excalidraw/excalidraw')
			const elements = apiRef.current.getSceneElements()
			const appState = apiRef.current.getAppState()
			const files = apiRef.current.getFiles()
			const svg = await exportToSvg({
				elements,
				appState,
				files,
				exportingFrame: null
			} as never)
			const svgString = new XMLSerializer().serializeToString(svg)
			const { collaborators: _collaborators, ...serializableAppState } = appState as Record<
				string,
				unknown
			> & {
				collaborators?: unknown
			}
			const sceneJson = JSON.stringify({
				elements,
				appState: serializableAppState,
				files
			})
			const svgWithScene = `<!-- excalidraw-scene: ${sceneJson} -->\n${svgString}`
			const blob = new Blob([svgWithScene], { type: 'image/svg+xml' })
			const file = new File([blob], 'drawing.svg', { type: 'image/svg+xml' })
			const assetPath = await uploadAsset(file)
			onSave(assetPath, assetPath)
		} catch {
			// ignore upload/export errors
		}
	}, [onSave, uploadAsset])

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex flex-col"
			onMouseDown={(event) => event.stopPropagation()}
			onPointerDown={(event) => event.stopPropagation()}
			onDragStart={(event) => event.preventDefault()}
		>
			<div className="flex h-full w-full flex-col">
				<div className="flex shrink-0 items-center justify-between border-b border-base-300 bg-base-100 px-4 py-2">
					<span className="text-sm font-semibold">Drawing</span>
					<div className="flex gap-2">
						<button className="btn btn-sm btn-ghost" onClick={onClose}>
							Cancel
						</button>
						<button className="btn btn-sm btn-primary" onClick={handleSave}>
							Save
						</button>
					</div>
				</div>
				<div className="flex-1 overflow-hidden">
					{loading ? (
						<div className="flex h-full items-center justify-center text-base-content/50">
							Loading…
						</div>
					) : (
						<Suspense
							fallback={
								<div className="flex h-full items-center justify-center text-base-content/50">
									Loading…
								</div>
							}
						>
							<Excalidraw
								key={drawingId ?? 'new'}
								excalidrawAPI={(api: unknown) => {
									apiRef.current = api as ExcalidrawAPI
								}}
								initialData={initialData as never}
							/>
						</Suspense>
					)}
				</div>
			</div>
		</div>,
		document.body
	)
}

export function makeDrawingNodeView(
	resolveAssetUrl: (src: string | null) => Promise<string | null>,
	readAssetBlob: (src: string | null) => Promise<Blob | null>,
	openDrawingEditor: (args: OpenDrawingEditorArgs) => void,
	isReadOnly: () => boolean,
	updateNodeAttrs: (node: PMNode, attrs: Record<string, unknown>) => void
) {
	return (pmNode: PMNode): NodeView => {
		const dom = document.createElement('div')
		const img = document.createElement('img')
		const empty = document.createElement('div')
		const overlay = document.createElement('div')
		const button = document.createElement('button')

		let currentNode = pmNode
		let renderToken = 0
		let objectUrl: string | null = null

		dom.className =
			'relative group my-2 overflow-hidden rounded-lg border border-base-300 bg-base-200'
		dom.tabIndex = 0

		img.className = 'block max-w-full'
		img.alt = 'drawing'
		img.draggable = false

		empty.className = 'flex h-32 items-center justify-center text-sm text-base-content/40'
		empty.textContent = 'Empty drawing'

		overlay.className =
			'absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 transition-opacity group-hover:opacity-100'

		button.type = 'button'
		button.className = 'btn btn-sm btn-ghost bg-base-100'
		button.textContent = 'Edit drawing'

		overlay.appendChild(button)
		dom.append(img, empty, overlay)

		const openEditor = () => {
			if (isReadOnly()) return
			openDrawingEditor({
				id: (currentNode.attrs.id as string | null) ?? null,
				onSave: (id, previewUrl) => {
					updateNodeAttrs(currentNode, { id, previewUrl })
				}
			})
		}

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Enter' && event.key !== ' ') return
			event.preventDefault()
			openEditor()
		}

		const syncDom = () => {
			const previewSrc = (currentNode.attrs.previewUrl as string | null) ?? null
			const readOnly = isReadOnly()

			if (previewSrc) {
				const token = ++renderToken
				void resolveAssetUrl(previewSrc)
					.then((url) => {
						if (token !== renderToken) return
						if (!url) {
							img.hidden = true
							empty.hidden = false
							return
						}
						return readAssetBlob(previewSrc).then((blob) => ({ blob }))
					})
					.then(async (result) => {
						if (!result || token !== renderToken || !result.blob) {
							img.hidden = true
							empty.hidden = false
							return
						}
						if (objectUrl) URL.revokeObjectURL(objectUrl)
						objectUrl = URL.createObjectURL(result.blob)
						img.src = objectUrl
						img.hidden = false
						empty.hidden = true
					})
					.catch(() => {
						if (token !== renderToken) return
						img.hidden = true
						empty.hidden = false
					})
			} else {
				renderToken++
				img.hidden = true
				empty.hidden = false
			}

			dom.style.cursor = readOnly ? 'default' : 'pointer'
			button.hidden = readOnly
			overlay.hidden = readOnly
			dom.setAttribute('aria-label', readOnly ? 'Drawing preview' : 'Edit drawing')
		}

		dom.addEventListener('click', openEditor)
		dom.addEventListener('keydown', handleKeyDown)
		syncDom()

		return {
			dom,
			update(node: PMNode) {
				if (node.type !== pmNode.type) return false
				currentNode = node
				syncDom()
				return true
			},
			destroy() {
				if (objectUrl) URL.revokeObjectURL(objectUrl)
				dom.removeEventListener('click', openEditor)
				dom.removeEventListener('keydown', handleKeyDown)
			},
			stopEvent() {
				return true
			},
			ignoreMutation() {
				return true
			}
		}
	}
}
