import { EditorState, type Plugin } from 'prosemirror-state'
import { history, undo, redo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap } from 'prosemirror-commands'
import { splitListItem, liftListItem } from 'prosemirror-schema-list'
import { dropCursor } from 'prosemirror-dropcursor'
import { gapCursor } from 'prosemirror-gapcursor'
import { tableEditing, goToNextCell, columnResizing } from 'prosemirror-tables'
import { schema } from '../../prosemirror-remark'
import { type ProseMirrorJsonDocument } from '../editCache'
import { buildBubbleMenuPlugin } from './plugins/bubbleMenu'
import { buildInputRules } from './plugins/inputRules'
import { exitCodeBlock } from './plugins/codeBlock'
import { clickLink, pasteLink } from './plugins/links'
import { placeholder } from './plugins/placeholder'
import { uploadPlugin } from './plugins/imageUpload'

// Assembles an EditorState from a serialised document.
// Pass extraPlugins for plugins that require runtime context (e.g. gutter menu).
export function buildState(doc: ProseMirrorJsonDocument, extraPlugins: Plugin[] = []): EditorState {
	return EditorState.create({
		schema,
		doc: schema.nodeFromJSON(doc),
		plugins: [
			history(),
			buildBubbleMenuPlugin(),
			buildInputRules(),
			keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo }),
			keymap({
				Enter: splitListItem(schema.nodes.list_item),
				'Shift-Tab': liftListItem(schema.nodes.list_item)
			}),
			keymap(baseKeymap),
			exitCodeBlock,
			clickLink,
			pasteLink,
			placeholder,
			uploadPlugin,
			dropCursor(),
			gapCursor(),
			columnResizing(),
			tableEditing(),
			keymap({ Tab: goToNextCell(1), 'Shift-Tab': goToNextCell(-1) }),
			...extraPlugins
		]
	})
}
