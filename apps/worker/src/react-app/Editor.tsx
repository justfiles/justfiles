import { useEffect, useRef } from 'react'
import { EditorState, Plugin, PluginKey, Selection, TextSelection } from 'prosemirror-state'
import { EditorView, Decoration, DecorationSet, type NodeView } from 'prosemirror-view'
import { type Node, type MarkType, type NodeType } from 'prosemirror-model'
import { schema } from '../prosemirror-remark'
import { tableEditing, goToNextCell, columnResizing } from 'prosemirror-tables'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap, toggleMark, setBlockType, wrapIn } from 'prosemirror-commands'
import { splitListItem, liftListItem } from 'prosemirror-schema-list'
import { history, undo, redo } from 'prosemirror-history'
import { dropCursor } from 'prosemirror-dropcursor'
import { gapCursor } from 'prosemirror-gapcursor'
import {
	inputRules,
	wrappingInputRule,
	textblockTypeInputRule,
	InputRule
} from 'prosemirror-inputrules'
import { ProseMirrorJsonDocument } from './sync'

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
	}
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
		}
	}
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
		}
	}
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
					Decoration.node(0, doc.firstChild.nodeSize, { class: 'is-placeholder' })
				])
			}
			return DecorationSet.empty
		}
	}
})

// ── Image upload ────────────────────────────────────────────────────────────

const uploadKey = new PluginKey<DecorationSet>('upload')

const uploadPlugin = new Plugin({
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

async function startImageUpload(
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
				.replaceWith(pos, pos, schema.nodes.image.create({ src: `asset:${key}`, alt: file.name }))
				.setMeta(uploadPlugin, { remove: { id } })
		)
	} catch {
		view.dispatch(view.state.tr.setMeta(uploadPlugin, { remove: { id } }))
	}
}

// Renders asset: URIs via the proxy endpoint
function makeImageNodeView(memoryId: string) {
	return (node: Node): NodeView => {
		const img = document.createElement('img')
		const src = node.attrs.src as string
		img.src = src.startsWith('asset:') ? `/api/v1/memory/${memoryId}/assets/${src.slice(6)}` : src
		img.alt = node.attrs.alt ?? ''
		if (node.attrs.title) img.title = node.attrs.title
		return { dom: img }
	}
}

// ── Menu ─────────────────────────────────────────────────────────────────────

type Command = (state: EditorState, dispatch?: EditorView['dispatch'], view?: EditorView) => boolean

interface MenuItem {
	dom: HTMLButtonElement
	command: Command
	active?: (state: EditorState) => boolean
}

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

function buildMenuPlugin(): Plugin {
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
		)
	]

	return new Plugin({
		view(editorView) {
			return new MenuView(items, editorView)
		}
	})
}

// ── Markdown input rules ─────────────────────────────────────────────────────

// Basic markdown input rules (heading, blockquote, code block, hr, lists)
function buildInputRules() {
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

function buildState(doc: ProseMirrorJsonDocument): EditorState {
	return EditorState.create({
		schema,
		doc: schema.nodeFromJSON(doc),
		plugins: [
			history(),
			buildMenuPlugin(),
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
			keymap({ Tab: goToNextCell(1), 'Shift-Tab': goToNextCell(-1) })
		]
	})
}

// ── React component ────────────────────────────────────────────────────────

type Props = {
	value: ProseMirrorJsonDocument
	onChange: (v: ProseMirrorJsonDocument) => void
	memoryId?: string
	getToken?: () => Promise<string | null>
	readOnly?: boolean
}

export function Editor({ value, onChange, memoryId, getToken, readOnly }: Props) {
	const containerRef = useRef<HTMLDivElement>(null)
	const viewRef = useRef<EditorView | null>(null)
	const onChangeRef = useRef(onChange)
	onChangeRef.current = onChange
	const readOnlyRef = useRef(readOnly)
	readOnlyRef.current = readOnly
	const memoryIdRef = useRef(memoryId)
	memoryIdRef.current = memoryId
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken

	// Mount editor once
	// Sync readOnly changes — dispatch a no-op transaction so ProseMirror re-evaluates editable()
	useEffect(() => {
		const view = viewRef.current
		if (!view) return
		view.dispatch(view.state.tr)
	}, [readOnly])

	useEffect(() => {
		const view = new EditorView(containerRef.current!, {
			// The editor owns its live state after mount. `value` is only used
			// as the initial ProseMirror document for this editor instance.
			state: buildState(value),
			editable: () => !readOnlyRef.current,
			nodeViews: memoryId ? { image: makeImageNodeView(memoryId) } : {},
			// Intercept ProseMirror's default scroll-into-view behavior, which
			// walks every DOM ancestor and sets scrollTop — on iPadOS PWA with a
			// physical keyboard this causes the entire layout to jump. Instead we
			// scroll only within the intended overflow-y-auto scroll container.
			handleScrollToSelection(view) {
				const scrollEl = containerRef.current?.closest(
					'.overflow-y-auto'
				) as HTMLElement | null
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
		</div>
	)
}
