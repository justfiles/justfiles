import { useEffect, useRef, useState } from 'react'
import { Selection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { type ProseMirrorJsonDocument } from '../editCache'
import { DrawingEditorModal, makeDrawingNodeView } from './DrawingNodeView'
import { startImageUpload, makeImageNodeView } from './plugins/imageUpload'
import { buildState } from './state'

type Props = {
	value: ProseMirrorJsonDocument
	onChange: (v: ProseMirrorJsonDocument) => void
	uploadAsset?: (file: File) => Promise<string>
	resolveAssetUrl?: (src: string) => Promise<string | null>
	readAssetBlob?: (src: string) => Promise<Blob | null>
	readOnly?: boolean
}

type DrawingEditorState = {
	id: string | null
	onSave: (id: string, previewUrl: string) => void
} | null

export function Editor({
	value,
	onChange,
	uploadAsset,
	resolveAssetUrl,
	readAssetBlob,
	readOnly
}: Props) {
	const containerRef = useRef<HTMLDivElement>(null)
	const viewRef = useRef<EditorView | null>(null)
	const [drawingEditor, setDrawingEditor] = useState<DrawingEditorState>(null)
	const onChangeRef = useRef(onChange)
	onChangeRef.current = onChange
	const readOnlyRef = useRef(readOnly)
	readOnlyRef.current = readOnly
	const uploadAssetRef = useRef(uploadAsset)
	uploadAssetRef.current = uploadAsset
	const resolveAssetUrlRef = useRef(resolveAssetUrl)
	resolveAssetUrlRef.current = resolveAssetUrl
	const readAssetBlobRef = useRef(readAssetBlob)
	readAssetBlobRef.current = readAssetBlob

	useEffect(() => {
		const view = viewRef.current
		if (!view) return
		view.dispatch(view.state.tr)
	}, [readOnly])

	useEffect(() => {
		const view = new EditorView(containerRef.current!, {
			state: buildState(value),
			editable: () => !readOnlyRef.current,
			nodeViews: resolveAssetUrl
				? {
						image: makeImageNodeView(
							(src) => resolveAssetUrlRef.current?.(src) ?? Promise.resolve(src),
							(src) => readAssetBlobRef.current?.(src) ?? Promise.resolve(null)
						),
						drawing: makeDrawingNodeView(
							(src) => resolveAssetUrlRef.current?.(src ?? '') ?? Promise.resolve(src),
							(src) => readAssetBlobRef.current?.(src ?? '') ?? Promise.resolve(null),
							({ id, onSave }) => {
								setDrawingEditor({ id, onSave })
							},
							() => !!readOnlyRef.current || !uploadAssetRef.current || !resolveAssetUrlRef.current,
							(node, attrs) => {
								const activeView = viewRef.current
								if (!activeView) return
								activeView.state.doc.descendants((n, pos) => {
									if (n === node) {
										activeView.dispatch(
											activeView.state.tr.setNodeMarkup(pos, undefined, { ...n.attrs, ...attrs })
										)
										return false
									}
									return true
								})
							}
						)
					}
				: {},
			handleScrollToSelection(activeView) {
				const scrollEl = containerRef.current?.closest('.overflow-y-auto') as HTMLElement | null
				if (!scrollEl) return false
				const { from } = activeView.state.selection
				const coords = activeView.coordsAtPos(from)
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
					const nextDoc = newState.doc.toJSON() as ProseMirrorJsonDocument
					onChangeRef.current(nextDoc)
				}
			},
			handleDrop(activeView, event) {
				const files = event.dataTransfer?.files
				if (!files?.length) return false
				event.preventDefault()
				const handleUpload = uploadAssetRef.current
				if (!handleUpload) return true
				const file = files[0]
				if (!file.type.startsWith('image/')) return true
				const coords = activeView.posAtCoords({ left: event.clientX, top: event.clientY })
				if (coords) {
					const $pos = activeView.state.doc.resolve(coords.pos)
					activeView.dispatch(activeView.state.tr.setSelection(Selection.near($pos)))
				}
				startImageUpload(activeView, file, handleUpload)
				return true
			},
			handlePaste(activeView, event) {
				const handleUpload = uploadAssetRef.current
				if (!handleUpload) return false
				const file = event.clipboardData?.files[0]
				if (!file?.type.startsWith('image/')) return false
				event.preventDefault()
				startImageUpload(activeView, file, handleUpload)
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
		<div className="editor-shell">
			<div ref={containerRef} className="pm-editor" />
			{drawingEditor ? (
				<DrawingEditorModal
					drawingId={drawingEditor.id}
					resolveAssetUrl={(src) => resolveAssetUrlRef.current?.(src ?? '') ?? Promise.resolve(src)}
					readAssetBlob={(src) => readAssetBlobRef.current?.(src ?? '') ?? Promise.resolve(null)}
					uploadAsset={(file) =>
						uploadAssetRef.current?.(file) ??
						Promise.reject(new Error('Asset uploads are unavailable'))
					}
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
