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

// The classic Mac OS X "Xcode" light palette — the look this app is named after:
// green comments, magenta keywords, brick-red strings, blue literals, teal types.
const xcodeLight = HighlightStyle.define([
	{
		tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
		color: '#007400',
		fontStyle: 'italic'
	},
	{
		tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.moduleKeyword, t.definitionKeyword],
		color: '#aa0d91'
	},
	{ tag: [t.string, t.special(t.string), t.regexp], color: '#c41a16' },
	{ tag: [t.number, t.bool, t.null, t.escape], color: '#1c00cf' },
	{ tag: [t.typeName, t.className, t.namespace], color: '#3f6e75' },
	{ tag: [t.propertyName, t.attributeName], color: '#6c36a9' },
	{ tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#326d74' },
	{ tag: t.meta, color: '#643820' },
	{ tag: t.invalid, color: '#c41a16' }
])

const theme = EditorView.theme(
	{
		'&': { height: '100%', backgroundColor: '#ffffff', color: '#1d1d1f', fontSize: '13px' },
		'&.cm-focused': { outline: 'none' },
		'.cm-scroller': {
			fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, monospace',
			lineHeight: '1.5',
			overflow: 'auto'
		},
		'.cm-gutters': { backgroundColor: '#ffffff', color: '#b4b4b8', border: '0' },
		'.cm-activeLine': { backgroundColor: '#f3f4f8' },
		'.cm-activeLineGutter': { backgroundColor: '#f3f4f8' },
		'.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
			backgroundColor: '#b3d7ff'
		},
		'.cm-cursor': { borderLeftColor: '#1d1d1f' }
	},
	{ dark: false }
)

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
			syntaxHighlighting(xcodeLight),
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
