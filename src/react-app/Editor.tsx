import { useEffect, useRef } from 'react'
import { EditorState, Plugin, TextSelection } from 'prosemirror-state'
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view'
import { schema } from 'prosemirror-markdown'
import { defaultMarkdownParser, defaultMarkdownSerializer } from 'prosemirror-markdown'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap } from 'prosemirror-commands'
import { history, undo, redo } from 'prosemirror-history'
import { dropCursor } from 'prosemirror-dropcursor'
import { gapCursor } from 'prosemirror-gapcursor'
import { inputRules, wrappingInputRule, textblockTypeInputRule, InputRule } from 'prosemirror-inputrules'

// ── Utilities ──────────────────────────────────────────────────────────────

function isUrl(text: string): boolean {
	try {
		const url = new URL(text.trim())
		return url.protocol === 'http:' || url.protocol === 'https:'
	} catch {
		return false
	}
}

// ── Plugins ────────────────────────────────────────────────────────────────

// Mod-Enter exits a code block by inserting a paragraph after it
const exitCodeBlock = keymap({
	'Mod-Enter': (state, dispatch) => {
		const { $head } = state.selection
		if ($head.parent.type.name !== 'code_block') return false
		const after = $head.after($head.depth)
		const tr = state.tr.insert(after, state.schema.nodes.paragraph.create())
		tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)))
		dispatch?.(tr.scrollIntoView())
		return true
	},
})

// Cmd/Ctrl+Click opens links in a new tab
const clickLink = new Plugin({
	props: {
		handleClick(view, pos, event) {
			if (!event.metaKey && !event.ctrlKey) return false
			const marks = view.state.doc.resolve(pos).marks()
			const link = marks.find((m) => m.type.name === 'link')
			if (!link) return false
			window.open(link.attrs.href, '_blank', 'noopener,noreferrer')
			return true
		},
	},
})

// When text is selected and clipboard contains a URL, paste wraps selection as a link
const pasteLink = new Plugin({
	props: {
		handlePaste(view, event) {
			const { state, dispatch } = view
			const { selection } = state
			if (selection.empty) return false
			const text = event.clipboardData?.getData('text/plain') ?? ''
			if (!isUrl(text)) return false
			event.preventDefault()
			const { from, to } = selection
			const mark = state.schema.marks.link.create({ href: text.trim() })
			dispatch(state.tr.addMark(from, to, mark))
			return true
		},
	},
})

// Shows a placeholder on the first paragraph when the doc is empty
const placeholder = new Plugin({
	props: {
		decorations(state) {
			const { doc } = state
			if (
				doc.childCount === 1 &&
				doc.firstChild?.isTextblock &&
				doc.firstChild.content.size === 0
			) {
				return DecorationSet.create(doc, [
					Decoration.node(0, doc.firstChild.nodeSize, { class: 'is-placeholder' }),
				])
			}
			return DecorationSet.empty
		},
	},
})

// Basic markdown input rules (heading, blockquote, code block, hr, lists)
function buildInputRules() {
	const { nodes } = schema
	return inputRules({
		rules: [
			// # Heading
			textblockTypeInputRule(/^(#{1,6})\s$/, nodes.heading, (match) => ({
				level: match[1].length,
			})),
			// > Blockquote
			wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
			// ``` Code block
			textblockTypeInputRule(/^```$/, nodes.code_block),
			// --- Horizontal rule
			new InputRule(/^---$/, (state, _match, start, end) => {
				const tr = state.tr.replaceWith(start - 1, end, nodes.horizontal_rule.create())
				return tr
			}),
		],
	})
}

function buildState(markdown: string): EditorState {
	return EditorState.create({
		schema,
		doc: defaultMarkdownParser.parse(markdown) ?? undefined,
		plugins: [
			history(),
			buildInputRules(),
			keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo }),
			keymap(baseKeymap),
			exitCodeBlock,
			clickLink,
			pasteLink,
			placeholder,
			dropCursor(),
			gapCursor(),
		],
	})
}

// ── React component ────────────────────────────────────────────────────────

type Props = {
	value: string
	onChange: (v: string) => void
}

export function Editor({ value, onChange }: Props) {
	const containerRef = useRef<HTMLDivElement>(null)
	const viewRef = useRef<EditorView | null>(null)
	const prevValueRef = useRef(value)

	// Mount editor once
	useEffect(() => {
		const view = new EditorView(containerRef.current!, {
			state: buildState(prevValueRef.current),
			dispatchTransaction(tr) {
				const newState = view.state.apply(tr)
				view.updateState(newState)
				if (tr.docChanged) {
					const md = defaultMarkdownSerializer.serialize(newState.doc)
					prevValueRef.current = md
					onChange(md)
				}
			},
		})
		viewRef.current = view
		view.focus()
		return () => view.destroy()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// Sync external value changes (e.g. switching notes)
	useEffect(() => {
		const view = viewRef.current
		if (!view) return
		if (value === prevValueRef.current) return
		prevValueRef.current = value
		view.updateState(buildState(value))
	}, [value])

	return (
		<div className="ghostore-editor h-full overflow-y-auto">
			<div ref={containerRef} className="ghostore-pm-editor" />
		</div>
	)
}
