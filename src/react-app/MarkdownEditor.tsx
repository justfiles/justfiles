import { useEffect, useRef } from 'react'
import { Milkdown, MilkdownProvider, useEditor, useInstance } from '@milkdown/react'
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/kit/core'
import { commonmark, linkSchema } from '@milkdown/kit/preset/commonmark'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { replaceAll, $prose } from '@milkdown/kit/utils'
import { keymap } from '@milkdown/kit/prose/keymap'
import { Plugin } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { TextSelection } from '@milkdown/kit/prose/state'

// Mod-Enter exits a code block by inserting a paragraph after it
const exitCodeBlock = $prose(() =>
	keymap({
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
)

function isUrl(text: string): boolean {
	try {
		const url = new URL(text.trim())
		return url.protocol === 'http:' || url.protocol === 'https:'
	} catch {
		return false
	}
}

// Cmd/Ctrl+Click opens links in a new tab
const clickLink = $prose(() =>
	new Plugin({
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
)

// When text is selected and clipboard contains a URL, paste wraps selection as a link
const pasteLink = $prose((ctx) =>
	new Plugin({
		props: {
			handlePaste(view, event) {
				const { state, dispatch } = view
				const { selection } = state
				if (selection.empty) return false
				const text = event.clipboardData?.getData('text/plain') ?? ''
				if (!isUrl(text)) return false
				event.preventDefault()
				const { from, to } = selection
				const mark = linkSchema.type(ctx).create({ href: text.trim() })
				dispatch(state.tr.addMark(from, to, mark))
				return true
			}
		}
	})
)

// Shows a placeholder on the first paragraph when the doc is empty
const placeholder = $prose(() =>
	new Plugin({
		props: {
			decorations(state) {
				const { doc } = state
				if (doc.childCount === 1 && doc.firstChild?.isTextblock && doc.firstChild.content.size === 0) {
					return DecorationSet.create(doc, [
						Decoration.node(0, doc.firstChild.nodeSize, { class: 'is-placeholder' })
					])
				}
				return DecorationSet.empty
			}
		}
	})
)

type InnerProps = {
	value: string
	onChange: (v: string) => void
	initialValue: string
}

function MilkdownInner({ value, onChange, initialValue }: InnerProps) {
	const [loading, get] = useInstance()
	const prevValue = useRef(initialValue)
	const isProgrammatic = useRef(false)

	useEditor((root) =>
		Editor.make()
			.config((ctx) => {
				ctx.set(rootCtx, root)
				ctx.set(defaultValueCtx, initialValue)
				ctx.get(listenerCtx).markdownUpdated((_, md) => {
					prevValue.current = md
					if (isProgrammatic.current) {
						isProgrammatic.current = false
						return
					}
					onChange(md)
				})
			})
			.use(commonmark)
			.use(listener)
			.use(pasteLink)
			.use(clickLink)
			.use(exitCodeBlock)
			.use(placeholder)
	)

	useEffect(() => {
		if (loading) return
		get()?.action((ctx) => ctx.get(editorViewCtx).focus())
	}, [loading, get])

	useEffect(() => {
		if (loading) return
		if (value === prevValue.current) return
		prevValue.current = value
		isProgrammatic.current = true
		get()?.action(replaceAll(value))
	}, [value, loading, get])

	return <Milkdown />
}

type Props = {
	value: string
	onChange: (v: string) => void
}

export function MarkdownEditor({ value, onChange }: Props) {
	const initialValue = useRef(value)

	return (
		<div className="ghostore-editor h-full overflow-y-auto">
			<MilkdownProvider>
				<MilkdownInner value={value} onChange={onChange} initialValue={initialValue.current} />
			</MilkdownProvider>
		</div>
	)
}
