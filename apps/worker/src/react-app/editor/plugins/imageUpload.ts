import { type Node } from 'prosemirror-model'
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView, type NodeView } from 'prosemirror-view'

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
	uploadAsset: (file: File) => Promise<string>
) {
	const id = {}
	let tr = view.state.tr
	if (!tr.selection.empty) tr.deleteSelection()
	tr.setMeta(uploadPlugin, { add: { id, pos: tr.selection.from } })
	view.dispatch(tr)

	try {
		const src = await uploadAsset(file)
		const pos = findPlaceholder(view.state, id)
		if (pos == null) return
		view.dispatch(
			view.state.tr
				.replaceWith(pos, pos, view.state.schema.nodes.image.create({ src, alt: file.name }))
				.setMeta(uploadKey, { remove: { id } })
		)
	} catch {
		view.dispatch(view.state.tr.setMeta(uploadKey, { remove: { id } }))
	}
}

export function makeImageNodeView(
	resolveAssetUrl: (src: string) => Promise<string | null>,
	readAssetBlob: (src: string) => Promise<Blob | null>
) {
	return (node: Node): NodeView => {
		const img = document.createElement('img')
		let objectUrl: string | null = null
		let renderToken = 0
		const src = node.attrs.src as string
		img.alt = node.attrs.alt ?? ''
		if (node.attrs.title) img.title = node.attrs.title
		void resolveAssetUrl(src).then((url) => {
			if (!url) return null
			const token = ++renderToken
			return readAssetBlob(src).then((blob) => ({ blob, token }))
		}).then(async (result) => {
			if (!result || result.token !== renderToken || !result.blob) return
			if (objectUrl) URL.revokeObjectURL(objectUrl)
			objectUrl = URL.createObjectURL(result.blob)
			img.src = objectUrl
		}).catch(() => {})
		return {
			dom: img,
			destroy() {
				if (objectUrl) URL.revokeObjectURL(objectUrl)
			}
		}
	}
}
