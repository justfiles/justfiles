import {
	InputRule,
	inputRules,
	textblockTypeInputRule,
	wrappingInputRule
} from 'prosemirror-inputrules'
import { schema } from '../../../prosemirror-remark'

// Markdown shorthand input rules: #, -, >, ```, ---
export function buildInputRules() {
	const { nodes } = schema
	return inputRules({
		rules: [
			// # Heading
			textblockTypeInputRule(/^(#{1,6})\s$/, nodes.heading, (match) => ({
				level: match[1].length
			})),
			// - Bullet list
			wrappingInputRule(/^\s*-\s$/, nodes.bullet_list),
			// > Blockquote
			wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
			// ``` Code block
			textblockTypeInputRule(/^```$/, nodes.code_block),
			// --- Horizontal rule
			new InputRule(/^---$/, (state, _match, start, end) => {
				const tr = state.tr.replaceWith(start - 1, end, nodes.horizontal_rule.create())
				return tr
			})
		]
	})
}
