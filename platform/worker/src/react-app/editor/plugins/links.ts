import { Plugin } from 'prosemirror-state'

function isUrl(text: string): boolean {
	try {
		const url = new URL(text.trim())
		return url.protocol === 'http:' || url.protocol === 'https:'
	} catch {
		return false
	}
}

// Cmd/Ctrl+Click opens links in a new tab
export const clickLink = new Plugin({
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
export const pasteLink = new Plugin({
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
