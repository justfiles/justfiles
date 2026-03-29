import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Node as PMNode } from 'prosemirror-model'
import type { NodeView } from 'prosemirror-view'

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
	memoryId: string
	drawingId: string | null
	getToken: () => Promise<string | null>
	onSave: (id: string, previewUrl: string) => void
	onClose: () => void
}

interface OpenDrawingEditorArgs {
	id: string | null
	onSave: (id: string, previewUrl: string) => void
}

function getDrawingPreviewUrl(memoryId: string, src: string | null): string | null {
	if (!src) return null
	return src.startsWith('asset:') ? `/api/v1/memory/${memoryId}/assets/${src.slice(6)}` : src
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
	memoryId,
	drawingId,
	getToken,
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
				const token = await getToken()
				const headers: Record<string, string> = {}
				if (token) headers.Authorization = `Bearer ${token}`
				const src = getDrawingPreviewUrl(memoryId, drawingId)
				if (!src) {
					if (!cancelled) setLoading(false)
					return
				}
				const res = await fetch(src, { headers })
				if (!res.ok) {
					if (!cancelled) setLoading(false)
					return
				}
				const svgText = await res.text()
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
	}, [drawingId, getToken, memoryId])

	const handleSave = useCallback(async () => {
		if (!apiRef.current) return

		try {
			const token = await getToken()
			if (!token) return

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
			const formData = new FormData()
			formData.append('file', file)

			const res = await fetch(`/api/v1/memory/${memoryId}/assets`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}` },
				body: formData
			})
			if (!res.ok) return

			const { key } = (await res.json()) as { key: string }
			const assetId = `asset:${key}`
			onSave(assetId, assetId)
		} catch {
			// ignore upload/export errors
		}
	}, [getToken, memoryId, onSave])

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
	memoryId: string,
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

		dom.className =
			'relative group my-2 overflow-hidden rounded-lg border border-base-300 bg-base-200'
		dom.tabIndex = 0

		img.className = 'block max-w-full'
		img.alt = 'drawing'
		img.draggable = false

		empty.className =
			'flex h-32 items-center justify-center text-sm text-base-content/40'
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
			const previewUrl = getDrawingPreviewUrl(
				memoryId,
				(currentNode.attrs.previewUrl as string | null) ?? null
			)
			const readOnly = isReadOnly()

			if (previewUrl) {
				img.src = previewUrl
				img.hidden = false
				empty.hidden = true
			} else {
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
