import { javascript } from '@codemirror/lang-javascript'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView, type ViewUpdate } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { basicSetup } from 'codemirror'

export type Editor = {
	dom: HTMLElement
	setDoc(content: string): void
	destroy(): void
}

// Xcode-ish syntax colours, with the actual palette supplied by CSS variables so
// the editor follows the platform sheet's light/dark tokens.
const xcodeSyntax = HighlightStyle.define([
	{
		tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
		color: 'var(--app-code-syntax-comment)',
		fontStyle: 'italic'
	},
	{
		tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.moduleKeyword, t.definitionKeyword],
		color: 'var(--app-code-syntax-keyword)'
	},
	{ tag: [t.string, t.special(t.string), t.regexp], color: 'var(--app-code-syntax-string)' },
	{ tag: [t.number, t.bool, t.null, t.escape], color: 'var(--app-code-syntax-literal)' },
	{ tag: [t.typeName, t.className, t.namespace], color: 'var(--app-code-syntax-type)' },
	{ tag: [t.propertyName, t.attributeName], color: 'var(--app-code-syntax-property)' },
	{
		tag: [t.function(t.variableName), t.function(t.propertyName)],
		color: 'var(--app-code-syntax-function)'
	},
	{ tag: t.meta, color: 'var(--app-code-syntax-meta)' },
	{ tag: t.invalid, color: 'var(--app-code-syntax-invalid)' }
])

const theme = EditorView.theme({
	'&': {
		height: '100%',
		backgroundColor: 'var(--window-bg)',
		color: 'var(--text)',
		fontSize: '13px'
	},
	'&.cm-focused': { outline: 'none' },
	'.cm-scroller': {
		fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, monospace',
		lineHeight: '1.5',
		overflow: 'auto'
	},
	'.cm-gutters': {
		backgroundColor: 'var(--window-bg)',
		color: 'var(--app-code-subtle)',
		border: '0'
	},
	'.cm-activeLine': { backgroundColor: 'var(--app-code-hover)' },
	'.cm-activeLineGutter': { backgroundColor: 'var(--app-code-hover)' },
	'.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
		backgroundColor: 'color-mix(in srgb, var(--focus) 30%, transparent)'
	},
	'.cm-cursor': { borderLeftColor: 'var(--text)' }
})

// A CodeMirror editor driven imperatively: `setDoc` loads a freshly-read file
// and user edits are reported through `onChange`. Programmatic `setDoc` calls
// never fire `onChange`, so loading a file never echoes back as a save.
export function createEditor(onChange: (content: string) => void): Editor {
	let loading = false
	const view = new EditorView({
		doc: '',
		extensions: [
			basicSetup,
			javascript({ typescript: true, jsx: true }),
			theme,
			syntaxHighlighting(xcodeSyntax),
			EditorView.updateListener.of((update: ViewUpdate) => {
				if (update.docChanged && !loading) onChange(update.state.doc.toString())
			})
		]
	})
	return {
		dom: view.dom,
		setDoc(content) {
			loading = true
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } })
			loading = false
		},
		destroy() {
			view.destroy()
		}
	}
}
