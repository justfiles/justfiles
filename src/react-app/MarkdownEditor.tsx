import { useEffect, useRef } from 'react'
import { Milkdown, MilkdownProvider, useEditor, useInstance } from '@milkdown/react'
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
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
	className?: string
}

export function MarkdownEditor({ value, onChange, className = '' }: Props) {
	const initialValue = useRef(value)

	return (
		<div className={`flex flex-1 flex-col min-h-0 overflow-hidden border border-slate-200 rounded-lg ${className}`}>
			<div className="ghostore-editor flex flex-1 flex-col overflow-auto">
				<MilkdownProvider>
					<MilkdownInner value={value} onChange={onChange} initialValue={initialValue.current} />
				</MilkdownProvider>
			</div>
		</div>
	)
}
