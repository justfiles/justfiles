import { lazy, Suspense, useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { NodeView } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'

// Lazy-load Excalidraw — ~2MB bundle, must not be in the main chunk
// Also loads Excalidraw's required CSS on first render
const Excalidraw = lazy(async () => {
	const [m] = await Promise.all([
		import('@excalidraw/excalidraw'),
		import('@excalidraw/excalidraw/index.css')
	])
	return { default: m.Excalidraw }
})

// ── Types ──────────────────────────────────────────────────────────────────

interface ExcalidrawAPI {
	getSceneElements: () => readonly unknown[]
	getAppState: () => Record<string, unknown>
	getFiles: () => Record<string, unknown>
}

// ── DrawingModal ───────────────────────────────────────────────────────────

interface DrawingModalProps {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	initialData: Record<string, any> | null
	onSave: (svg: string) => void
	onClose: () => void
}

function DrawingModal({ initialData, onSave, onClose }: DrawingModalProps) {
	const apiRef = useRef<ExcalidrawAPI | null>(null)

	const handleSave = useCallback(async () => {
		if (!apiRef.current) return
		const { exportToSvg } = await import('@excalidraw/excalidraw')
		const elements = apiRef.current.getSceneElements()
		const appState = apiRef.current.getAppState()
		const files = apiRef.current.getFiles()
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const svg = await exportToSvg({ elements, appState, files, exportingFrame: null } as any)
		const svgString = new XMLSerializer().serializeToString(svg)
		// Strip transient/non-serialisable appState fields before embedding.
		// `collaborators` is a Map — JSON.stringify drops it silently; omitting it
		// lets Excalidraw fall back to its own default (empty Map) on restore.
		const { collaborators: _c, ...serializableAppState } = appState as Record<string, unknown> & { collaborators?: unknown }
		const sceneJson = JSON.stringify({ elements, appState: serializableAppState, files })
		const svgWithScene = `<!-- excalidraw-scene: ${sceneJson} -->\n${svgString}`
		onSave(svgWithScene)
	}, [onSave])

	// Rendered via portal into document.body — completely outside the ProseMirror
	// NodeView DOM so the editor's draggable="true" can't intercept Excalidraw gestures.
	return createPortal(
		<div
			className="fixed inset-0 z-50 flex flex-col"
			// Prevent any events from leaking back into the editor
			onMouseDown={(e) => e.stopPropagation()}
			onPointerDown={(e) => e.stopPropagation()}
			onDragStart={(e) => e.preventDefault()}
		>
			<div className="flex flex-col w-full h-full">
				<div className="flex items-center justify-between px-4 py-2 border-b border-base-300 bg-base-100 shrink-0">
					<span className="font-semibold text-sm">Drawing</span>
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
					<Suspense
						fallback={
							<div className="flex items-center justify-center h-full text-base-content/50">
								Loading…
							</div>
						}
					>
						<Excalidraw
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							excalidrawAPI={(api: any) => {
								apiRef.current = api as ExcalidrawAPI
							}}
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							initialData={initialData as any}
						/>
					</Suspense>
				</div>
			</div>
		</div>,
		document.body
	)
}

// ── DrawingPreview ─────────────────────────────────────────────────────────

interface DrawingPreviewProps {
	src: string | null
	memoryId: string
	onEdit: () => void
}

function DrawingPreview({ src, memoryId, onEdit }: DrawingPreviewProps) {
	const imgSrc =
		src?.startsWith('asset:') ? `/api/v1/memory/${memoryId}/assets/${src.slice(6)}` : src

	return (
		<div
			className="relative group border border-base-300 rounded-lg overflow-hidden cursor-pointer my-2 bg-base-200"
			onClick={onEdit}
		>
			{imgSrc ? (
				<img src={imgSrc} alt="drawing" className="max-w-full block" draggable={false} />
			) : (
				<div className="flex items-center justify-center h-32 text-base-content/40 text-sm">
					Empty drawing — click to edit
				</div>
			)}
			<div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20">
				<span className="btn btn-sm btn-ghost bg-base-100">Edit drawing</span>
			</div>
		</div>
	)
}

// ── DrawingNodeViewComponent ───────────────────────────────────────────────

interface Props {
	node: PMNode
	memoryId: string
	getToken: () => Promise<string | null>
	onUpdate: (id: string, previewUrl: string) => void
}

function DrawingNodeViewComponent({ node, memoryId, getToken, onUpdate }: Props) {
	const [editing, setEditing] = useState(false)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const [initialData, setInitialData] = useState<Record<string, any> | null>(null)

	const handleEdit = useCallback(async () => {
		const id = node.attrs.id as string | null
		if (id) {
			try {
				const token = await getToken()
				const headers: Record<string, string> = {}
				if (token) headers.Authorization = `Bearer ${token}`
				const src = id.startsWith('asset:')
					? `/api/v1/memory/${memoryId}/assets/${id.slice(6)}`
					: id
				const res = await fetch(src, { headers })
				if (res.ok) {
					const svgText = await res.text()
					// Extract scene JSON from the comment we prepend on save
					const match = svgText.match(/^<!-- excalidraw-scene: ([\s\S]*?) -->/)
					if (match) {
						try {
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							const parsed: any = JSON.parse(match[1])
							// collaborators must be a Map; JSON.parse gives a plain object
							if (parsed.appState) {
								parsed.appState.collaborators = new Map(
									Object.entries(parsed.appState.collaborators ?? {})
								)
							}
							setInitialData(parsed)
						} catch {
							// couldn't parse embedded scene, open empty
						}
					}
				}
			} catch {
				// network error — open empty
			}
		}
		setEditing(true)
	}, [node.attrs.id, memoryId, getToken])

	const handleSave = useCallback(
		async (svgString: string) => {
			setEditing(false)
			try {
				const token = await getToken()
				if (!token) return
				const blob = new Blob([svgString], { type: 'image/svg+xml' })
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
				onUpdate(`asset:${key}`, `asset:${key}`)
			} catch {
				// ignore upload errors
			}
		},
		[memoryId, getToken, onUpdate]
	)

	return (
		<>
			<DrawingPreview
				src={node.attrs.previewUrl as string | null}
				memoryId={memoryId}
				onEdit={handleEdit}
			/>
			{editing && (
				<DrawingModal
					initialData={initialData}
					onSave={handleSave}
					onClose={() => setEditing(false)}
				/>
			)}
		</>
	)
}

// ── ProseMirror NodeView factory ───────────────────────────────────────────

export function makeDrawingNodeView(
	memoryId: string,
	getToken: () => Promise<string | null>,
	updateNodeAttrs: (node: PMNode, attrs: Record<string, unknown>) => void
) {
	return (pmNode: PMNode): NodeView => {
		const dom = document.createElement('div')
		const root = createRoot(dom)

		let currentNode = pmNode

		const render = () => {
			root.render(
				<DrawingNodeViewComponent
					node={currentNode}
					memoryId={memoryId}
					getToken={getToken}
					onUpdate={(id, previewUrl) => {
						updateNodeAttrs(currentNode, { id, previewUrl })
					}}
				/>
			)
		}

		render()

		return {
			dom,
			update(node: PMNode) {
				if (node.type !== pmNode.type) return false
				currentNode = node
				render()
				return true
			},
			destroy() {
				root.unmount()
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
