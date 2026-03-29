import { Plugin, TextSelection } from 'prosemirror-state'
import { type EditorView } from 'prosemirror-view'
import { startImageUpload } from './imageUpload'

export interface GutterPluginOptions {
	getMemoryId: () => string | undefined
	getToken: () => Promise<string | null>
}

export function buildGutterPlugin(opts: GutterPluginOptions): Plugin {
	const btn = document.createElement('button')
	btn.type = 'button'
	btn.className = 'btn btn-ghost btn-xs'
	btn.setAttribute('aria-label', 'Insert block')
	btn.textContent = '+'
	btn.style.cssText =
		'position:fixed;display:none;z-index:40;width:20px;height:20px;min-height:0;padding:0;font-size:15px;line-height:1;'

	const menu = document.createElement('div')
	menu.className =
		'flex flex-col gap-0.5 p-1 rounded-lg shadow-lg border border-base-300 bg-base-100'
	menu.style.cssText = 'position:fixed;display:none;z-index:50;min-width:160px;'

	const fileInput = document.createElement('input')
	fileInput.type = 'file'
	fileInput.accept = 'image/*'
	fileInput.style.display = 'none'

	document.body.appendChild(btn)
	document.body.appendChild(menu)
	document.body.appendChild(fileInput)

	let currentView: EditorView | null = null
	let menuOpen = false

	const closeMenu = () => {
		menu.style.display = 'none'
		menuOpen = false
	}

	const openMenu = () => {
		menu.style.display = 'flex'
		menuOpen = true
		const btnRect = btn.getBoundingClientRect()
		// Compute position after paint so menu dimensions are available
		requestAnimationFrame(() => {
			const mw = menu.offsetWidth
			const mh = menu.offsetHeight
			const vw = window.innerWidth
			const vh = window.innerHeight
			let left = btnRect.right + 6
			if (left + mw > vw - 8) left = Math.max(8, btnRect.left - mw - 6)
			let top = btnRect.top
			if (top + mh > vh - 8) top = Math.max(8, vh - mh - 8)
			menu.style.left = left + 'px'
			menu.style.top = top + 'px'
		})
	}

	const makeItem = (label: string, onClick: () => void): HTMLButtonElement => {
		const b = document.createElement('button')
		b.type = 'button'
		b.className = 'btn btn-ghost btn-sm justify-start text-left font-normal normal-case w-full'
		b.textContent = label
		b.addEventListener('mousedown', (e) => {
			e.preventDefault()
			closeMenu()
			onClick()
		})
		return b
	}

	// Returns {from, to} of the current empty top-level paragraph, or null
	const emptyParaRange = (): { from: number; to: number } | null => {
		if (!currentView) return null
		const { $from } = currentView.state.selection
		const { nodes } = currentView.state.schema
		if (
			$from.depth === 1 &&
			$from.parent.type === nodes.paragraph &&
			$from.parent.childCount === 0
		) {
			return { from: $from.before(1), to: $from.after(1) }
		}
		return null
	}

	const afterCurrentBlock = (): number => {
		if (!currentView) return 0
		const { $from } = currentView.state.selection
		return $from.depth >= 1 ? $from.after(1) : $from.pos
	}

	// ── Menu items ───────────────────────────────────────────────────────────
	// To add a new item: append a makeItem() call below with its insert logic.

	// Image
	menu.appendChild(makeItem('Image', () => fileInput.click()))

	// Drawing
	menu.appendChild(
		makeItem('Drawing', () => {
			if (!currentView) return
			const v = currentView
			const { nodes } = v.state.schema
			const range = emptyParaRange()
			const tr = v.state.tr
			if (range) {
				tr.replaceWith(range.from, range.to, nodes.drawing.create({ id: null, previewUrl: null }))
			} else {
				tr.insert(afterCurrentBlock(), nodes.drawing.create({ id: null, previewUrl: null }))
			}
			v.dispatch(tr)
			v.focus()
		})
	)

	// Divider
	menu.appendChild(
		makeItem('Divider', () => {
			if (!currentView) return
			const v = currentView
			const { nodes } = v.state.schema
			const range = emptyParaRange()
			const tr = v.state.tr
			if (range) {
				tr.replaceWith(range.from, range.to, [
					nodes.horizontal_rule.create(),
					nodes.paragraph.create()
				])
				try {
					tr.setSelection(TextSelection.near(tr.doc.resolve(range.from + 2)))
				} catch {
					// position may not exist if at end of doc
				}
			} else {
				const pos = afterCurrentBlock()
				tr.insert(pos, [nodes.horizontal_rule.create(), nodes.paragraph.create()])
				try {
					tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 2)))
				} catch {
					// ignore
				}
			}
			v.dispatch(tr.scrollIntoView())
			v.focus()
		})
	)

	// Table
	// TODO: table is not that simple, remove it for now
	// menu.appendChild(
	// 	makeItem('Table', () => {
	// 		if (!currentView) return
	// 		const v = currentView
	// 		const { nodes } = v.state.schema
	// 		const makeCell = (isHeader: boolean) =>
	// 			(isHeader ? nodes.table_header : nodes.table_cell).createAndFill()!
	// 		const makeRow = (isHeader: boolean) =>
	// 			nodes.table_row.create(null, [makeCell(isHeader), makeCell(isHeader)])
	// 		const table = nodes.table.create(null, [makeRow(true), makeRow(false)])
	// 		const range = emptyParaRange()
	// 		const tr = v.state.tr
	// 		if (range) {
	// 			tr.replaceWith(range.from, range.to, table)
	// 		} else {
	// 			tr.insert(afterCurrentBlock(), table)
	// 		}
	// 		v.dispatch(tr.scrollIntoView())
	// 		v.focus()
	// 	})
	// )

	// ── Event listeners ──────────────────────────────────────────────────────

	fileInput.addEventListener('change', () => {
		const file = fileInput.files?.[0]
		fileInput.value = ''
		if (!file || !currentView) return
		const mid = opts.getMemoryId()
		if (!mid) return
		startImageUpload(currentView, file, mid, opts.getToken)
		currentView.focus()
	})

	btn.addEventListener('mousedown', (e) => {
		e.preventDefault()
		menuOpen ? closeMenu() : openMenu()
	})

	const onOutsideClick = (e: MouseEvent) => {
		if (!menu.contains(e.target as globalThis.Node) && !btn.contains(e.target as globalThis.Node)) {
			closeMenu()
		}
	}
	document.addEventListener('mousedown', onOutsideClick)

	// ── Plugin ───────────────────────────────────────────────────────────────

	return new Plugin({
		view(editorView) {
			currentView = editorView
			return {
				update(v) {
					currentView = v

					if (!v.editable) {
						btn.style.display = 'none'
						if (menuOpen) closeMenu()
						return
					}

					const { selection } = v.state
					if (!selection.empty) {
						btn.style.display = 'none'
						if (menuOpen) closeMenu()
						return
					}

					const { $from } = selection
					// Show only on empty top-level text blocks
					const isEmptyTopLevel =
						$from.depth === 1 && $from.parent.isTextblock && $from.parent.childCount === 0

					if (!isEmptyTopLevel) {
						btn.style.display = 'none'
						if (menuOpen) closeMenu()
						return
					}

					const coords = v.coordsAtPos($from.pos)
					const editorRect = v.dom.getBoundingClientRect()
					const btnH = 20
					const btnTop = Math.round((coords.top + coords.bottom) / 2 - btnH / 2)

					// .ProseMirror has pl-10 (40px) left gutter. Center the 20px button: offset = (40-20)/2 = 10
					btn.style.left = editorRect.left + 10 + 'px'
					btn.style.top = btnTop + 'px'
					btn.style.display = 'flex'
					btn.style.alignItems = 'center'
					btn.style.justifyContent = 'center'
				},
				destroy() {
					document.removeEventListener('mousedown', onOutsideClick)
					btn.remove()
					menu.remove()
					fileInput.remove()
					currentView = null
				}
			}
		}
	})
}
