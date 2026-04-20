import { keymap } from 'prosemirror-keymap'
import { TextSelection } from 'prosemirror-state'

// Mod-Enter exits a code block by inserting a paragraph after it
export const exitCodeBlock = keymap({
	'Mod-Enter': (state, dispatch) => {
		const { $head } = state.selection
		if ($head.parent.type.name !== 'code_block') return false
		const after = $head.after($head.depth)
		const tr = state.tr.insert(after, state.schema.nodes.paragraph.create())
		tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)))
		dispatch?.(tr.scrollIntoView())
		return true
	}
})
