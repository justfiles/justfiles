import { Plugin, PluginKey, type EditorState } from 'prosemirror-state'
import { type EditorView, Decoration, DecorationSet, type NodeView } from 'prosemirror-view'
import { type Node } from 'prosemirror-model'

const uploadKey = new PluginKey<DecorationSet>('upload')

export const uploadPlugin = new Plugin({
	key: uploadKey,
	state: {
		init() {
			return DecorationSet.empty
		},
		apply(tr, set) {
			set = set.map(tr.mapping, tr.doc)
			const action = tr.getMeta(uploadKey)
			if (action?.add) {
				const widget = document.createElement('upload-placeholder')
				const deco = Decoration.widget(action.add.pos, widget, { id: action.add.id })
				set = set.add(tr.doc, [deco])
			} else if (action?.remove) {
				set = set.remove(set.find(undefined, undefined, (spec) => spec.id === action.remove.id))
			}
			return set
		}
	},
	props: {
		decorations(state) {
			return this.getState(state)
		}
	}
})

function findPlaceholder(state: EditorState, id: object): number | null {
	const decos = uploadKey.getState(state)
	const found = decos?.find(undefined, undefined, (spec) => spec.id === id)
	return found?.length ? found[0].from : null
}

export async function startImageUpload(
	view: EditorView,
	file: File,
	memoryId: string,
	getToken: () => Promise<string | null>
) {
	const id = {}
	let tr = view.state.tr
	if (!tr.selection.empty) tr.deleteSelection()
	tr.setMeta(uploadPlugin, { add: { id, pos: tr.selection.from } })
	view.dispatch(tr)

	try {
		const token = await getToken()
		if (!token) throw new Error('Missing auth token')
		const formData = new FormData()
		formData.append('file', file)
		const res = await fetch(`/api/v1/memory/${memoryId}/assets`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` },
			body: formData
		})
		if (!res.ok) throw new Error('Upload failed')
		const { key } = (await res.json()) as { key: string }
		const pos = findPlaceholder(view.state, id)
		if (pos == null) return
		view.dispatch(
			view.state.tr
				.replaceWith(pos, pos, view.state.schema.nodes.image.create({ src: `asset:${key}`, alt: file.name }))
				.setMeta(uploadPlugin, { remove: { id } })
		)
	} catch {
		view.dispatch(view.state.tr.setMeta(uploadPlugin, { remove: { id } }))
	}
}

// Renders asset: URIs via the proxy endpoint
export function makeImageNodeView(memoryId: string) {
	return (node: Node): NodeView => {
		const img = document.createElement('img')
		const src = node.attrs.src as string
		img.src = src.startsWith('asset:') ? `/api/v1/memory/${memoryId}/assets/${src.slice(6)}` : src
		img.alt = node.attrs.alt ?? ''
		if (node.attrs.title) img.title = node.attrs.title
		return { dom: img }
	}
}
