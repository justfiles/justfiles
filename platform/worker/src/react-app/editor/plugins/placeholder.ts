import { Plugin } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

// Shows a placeholder on the first paragraph when the doc is empty
export const placeholder = new Plugin({
	props: {
		decorations(state) {
			const { doc } = state
			if (
				doc.childCount === 1 &&
				doc.firstChild?.isTextblock &&
				doc.firstChild.content.size === 0
			) {
				return DecorationSet.create(doc, [
					Decoration.node(0, doc.firstChild.nodeSize, { class: 'is-placeholder' })
				])
			}
			return DecorationSet.empty
		}
	}
})
