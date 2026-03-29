import { Plugin, type EditorState } from 'prosemirror-state'
import { type EditorView } from 'prosemirror-view'
import { type MarkType, type NodeType } from 'prosemirror-model'
import { toggleMark, setBlockType, wrapIn } from 'prosemirror-commands'
import { schema } from '../../../prosemirror-remark'

// ── State helpers ────────────────────────────────────────────────────────────

function markActive(state: EditorState, markType: MarkType): boolean {
	const { from, $from, to, empty } = state.selection
	if (empty) return !!markType.isInSet(state.storedMarks || $from.marks())
	return state.doc.rangeHasMark(from, to, markType)
}

function blockActive(
	state: EditorState,
	nodeType: NodeType,
	attrs: Record<string, unknown> = {}
): boolean {
	const { $from, to } = state.selection
	return to <= $from.end() && $from.parent.hasMarkup(nodeType, attrs)
}

function wrapActive(state: EditorState, nodeType: NodeType): boolean {
	const { $from } = state.selection
	for (let d = $from.depth; d > 0; d--) {
		if ($from.node(d).type === nodeType) return true
	}
	return false
}

// ── Menu item ────────────────────────────────────────────────────────────────

type Command = (state: EditorState, dispatch?: EditorView['dispatch'], view?: EditorView) => boolean

interface MenuItem {
	dom: HTMLButtonElement
	command: Command
	active?: (state: EditorState) => boolean
}

function makeMenuItem(
	label: string,
	title: string,
	command: Command,
	active?: (state: EditorState) => boolean
): MenuItem {
	const dom = document.createElement('button')
	dom.type = 'button'
	dom.className = 'btn btn-ghost btn-xs font-mono'
	dom.textContent = label
	dom.title = title
	return { dom, command, active }
}

// ── Menu view ────────────────────────────────────────────────────────────────

class MenuView {
	items: MenuItem[]
	editorView: EditorView
	dom: HTMLElement

	constructor(items: MenuItem[], editorView: EditorView) {
		this.items = items
		this.editorView = editorView

		this.dom = document.createElement('div')
		this.dom.className =
			'flex flex-wrap gap-1 p-1 rounded-lg shadow-lg border border-base-300 bg-base-100'
		this.dom.style.cssText = 'position:fixed;display:none;z-index:50;'
		items.forEach(({ dom }) => this.dom.appendChild(dom))
		document.body.appendChild(this.dom)

		this.dom.addEventListener('mousedown', (e) => {
			e.preventDefault()
			editorView.focus()
			items.forEach(({ command, dom }) => {
				if (e.target instanceof globalThis.Node && dom.contains(e.target)) {
					command(editorView.state, editorView.dispatch, editorView)
				}
			})
		})
	}

	update() {
		const { state } = this.editorView

		this.items.forEach(({ command, dom, active }) => {
			const isActive = active ? active(state) : false
			const canRun = command(state, undefined)
			dom.classList.toggle('btn-active', isActive)
			dom.style.opacity = canRun || isActive ? '1' : '0.3'
		})

		if (state.selection.empty) {
			this.dom.style.display = 'none'
			return
		}

		const winSel = window.getSelection()
		if (!winSel || winSel.rangeCount === 0) return
		const rect = winSel.getRangeAt(0).getBoundingClientRect()
		if (rect.width === 0 && rect.height === 0) return

		this.dom.style.display = 'flex'

		const menuW = this.dom.offsetWidth
		const menuH = this.dom.offsetHeight
		const gap = 8

		let left = rect.left + rect.width / 2 - menuW / 2
		let top = rect.top - menuH - gap

		// clamp horizontally
		left = Math.max(gap, Math.min(left, window.innerWidth - menuW - gap))
		// flip below if too close to the top of the viewport
		if (top < gap) top = rect.bottom + gap

		this.dom.style.left = left + 'px'
		this.dom.style.top = top + 'px'
	}

	destroy() {
		this.dom.remove()
	}
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export function buildBubbleMenuPlugin(): Plugin {
	const { marks, nodes } = schema
	const items: MenuItem[] = [
		makeMenuItem('B', 'Bold', toggleMark(marks.strong), (s) => markActive(s, marks.strong)),
		makeMenuItem('I', 'Italic', toggleMark(marks.em), (s) => markActive(s, marks.em)),
		makeMenuItem('`', 'Code', toggleMark(marks.code), (s) => markActive(s, marks.code)),
		makeMenuItem('¶', 'Paragraph', setBlockType(nodes.paragraph), (s) =>
			blockActive(s, nodes.paragraph)
		),
		makeMenuItem('H1', 'Heading 1', setBlockType(nodes.heading, { level: 1 }), (s) =>
			blockActive(s, nodes.heading, { level: 1 })
		),
		makeMenuItem('H2', 'Heading 2', setBlockType(nodes.heading, { level: 2 }), (s) =>
			blockActive(s, nodes.heading, { level: 2 })
		),
		makeMenuItem('H3', 'Heading 3', setBlockType(nodes.heading, { level: 3 }), (s) =>
			blockActive(s, nodes.heading, { level: 3 })
		),
		makeMenuItem('❝', 'Blockquote', wrapIn(nodes.blockquote), (s) =>
			wrapActive(s, nodes.blockquote)
		),
		makeMenuItem('{ }', 'Code block', setBlockType(nodes.code_block), (s) =>
			blockActive(s, nodes.code_block)
		),
		makeMenuItem('✏', 'Drawing', (state, dispatch) => {
			const { $from } = state.selection
			const insertPos = $from.depth >= 1 ? $from.after(1) : $from.pos
			if (!dispatch) return true
			dispatch(state.tr.insert(insertPos, nodes.drawing.create({ id: null, previewUrl: null })))
			return true
		})
	]

	return new Plugin({
		view(editorView) {
			return new MenuView(items, editorView)
		}
	})
}
