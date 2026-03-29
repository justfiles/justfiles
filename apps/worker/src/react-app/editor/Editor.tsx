import { useEffect, useRef, useState } from 'react'
import { Selection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { type ProseMirrorJsonDocument } from '../sync'
import { buildState } from './state'
import { buildGutterPlugin } from './plugins/gutterMenu'
import { startImageUpload, makeImageNodeView } from './plugins/imageUpload'
import { DrawingEditorModal, makeDrawingNodeView } from './DrawingNodeView'

type Props = {
	value: ProseMirrorJsonDocument
	onChange: (v: ProseMirrorJsonDocument) => void
	memoryId?: string
	getToken?: () => Promise<string | null>
	readOnly?: boolean
}

type DrawingEditorState = {
	id: string | null
	onSave: (id: string, previewUrl: string) => void
} | null

export function Editor({ value, onChange, memoryId, getToken, readOnly }: Props) {
	const containerRef = useRef<HTMLDivElement>(null)
	const viewRef = useRef<EditorView | null>(null)
	const [drawingEditor, setDrawingEditor] = useState<DrawingEditorState>(null)
	const onChangeRef = useRef(onChange)
	onChangeRef.current = onChange
	const readOnlyRef = useRef(readOnly)
	readOnlyRef.current = readOnly
	const memoryIdRef = useRef(memoryId)
	memoryIdRef.current = memoryId
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken

	// Sync readOnly changes — dispatch a no-op transaction so ProseMirror re-evaluates editable()
	useEffect(() => {
		const view = viewRef.current
		if (!view) return
		view.dispatch(view.state.tr)
	}, [readOnly])

	// Mount editor once
	useEffect(() => {
		const gutterPlugin = buildGutterPlugin({
			getMemoryId: () => memoryIdRef.current,
			getToken: () => getTokenRef.current?.() ?? Promise.resolve(null)
		})

		const view = new EditorView(containerRef.current!, {
			// The editor owns its live state after mount. `value` is only used
			// as the initial ProseMirror document for this editor instance.
			state: buildState(value, [gutterPlugin]),
			editable: () => !readOnlyRef.current,
			nodeViews: memoryId
				? {
						image: makeImageNodeView(memoryId),
						drawing: makeDrawingNodeView(
							memoryId,
							({ id, onSave }) => {
								setDrawingEditor({ id, onSave })
							},
							() => !!readOnlyRef.current,
							(node, attrs) => {
								const view = viewRef.current
								if (!view) return
								view.state.doc.descendants((n, pos) => {
									if (n === node) {
										view.dispatch(
											view.state.tr.setNodeMarkup(pos, undefined, { ...n.attrs, ...attrs })
										)
										return false
									}
									return true
								})
							}
						)
					}
				: {},
			// Intercept ProseMirror's default scroll-into-view behavior, which
			// walks every DOM ancestor and sets scrollTop — on iPadOS PWA with a
			// physical keyboard this causes the entire layout to jump. Instead we
			// scroll only within the intended overflow-y-auto scroll container.
			handleScrollToSelection(view) {
				const scrollEl = containerRef.current?.closest('.overflow-y-auto') as HTMLElement | null
				if (!scrollEl) return false
				const { from } = view.state.selection
				const coords = view.coordsAtPos(from)
				const box = scrollEl.getBoundingClientRect()
				const padding = 32
				const relTop = coords.top - box.top
				const relBottom = coords.bottom - box.top
				if (relBottom > box.height - padding) {
					scrollEl.scrollTop += relBottom - box.height + padding
				} else if (relTop < padding) {
					scrollEl.scrollTop += relTop - padding
				}
				return true
			},
			dispatchTransaction(tr) {
				const newState = view.state.apply(tr)
				view.updateState(newState)
				if (tr.docChanged) {
					const d = newState.doc.toJSON() as ProseMirrorJsonDocument
					onChangeRef.current(d)
				}
			},
			handleDrop(view, event) {
				const files = event.dataTransfer?.files
				if (!files?.length) return false
				// Always prevent default for file drops — otherwise the browser navigates to the file URL
				event.preventDefault()
				const mid = memoryIdRef.current
				if (!mid) return true
				const file = files[0]
				if (!file.type.startsWith('image/')) return true
				const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
				if (coords) {
					const $pos = view.state.doc.resolve(coords.pos)
					view.dispatch(view.state.tr.setSelection(Selection.near($pos)))
				}
				startImageUpload(view, file, mid, getTokenRef.current ?? (() => Promise.resolve(null)))
				return true
			},
			handlePaste(view, event) {
				const mid = memoryIdRef.current
				if (!mid) return false
				const file = event.clipboardData?.files[0]
				if (!file?.type.startsWith('image/')) return false
				event.preventDefault()
				startImageUpload(view, file, mid, getTokenRef.current ?? (() => Promise.resolve(null)))
				return true
			}
		})
		viewRef.current = view
		view.focus()
		return () => {
			view.destroy()
			viewRef.current = null
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	return (
		<div className="ghostore-editor">
			<div ref={containerRef} className="ghostore-pm-editor" />
			{memoryId && drawingEditor ? (
				<DrawingEditorModal
					memoryId={memoryId}
					drawingId={drawingEditor.id}
					getToken={getTokenRef.current ?? (() => Promise.resolve(null))}
					onSave={(id, previewUrl) => {
						drawingEditor.onSave(id, previewUrl)
						setDrawingEditor(null)
					}}
					onClose={() => setDrawingEditor(null)}
				/>
			) : null}
		</div>
	)
}
