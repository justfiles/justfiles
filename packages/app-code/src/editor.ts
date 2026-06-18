import { javascript } from '@codemirror/lang-javascript'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { type Diagnostic as CmDiagnostic, lintGutter, setDiagnostics } from '@codemirror/lint'
import { EditorView, type ViewUpdate } from '@codemirror/view'
import type { Diagnostic } from '@justfiles/app/engine'
import { tags as t } from '@lezer/highlight'
import { basicSetup } from 'codemirror'

export type Editor = {
	dom: HTMLElement
	setDoc(content: string): void
	// Replace the inline diagnostics with the engine's LSP-shaped ones (already
	// filtered to this file). Underlines, hover tooltips and a gutter marker.
	setDiagnostics(diagnostics: Diagnostic[]): void
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
	'.cm-cursor': { borderLeftColor: 'var(--text)' },
	// Inline diagnostics: keep the hover tooltip on the platform sheet so it
	// reads in dark mode (CodeMirror's default tooltip is light-only).
	'.cm-tooltip': {
		backgroundColor: 'var(--surface)',
		color: 'var(--text)',
		border: '1px solid var(--rule)'
	},
	'.cm-diagnostic': { fontFamily: 'var(--app-code-mono)', fontSize: '12px' },
	'.cm-diagnostic-error': { borderLeftColor: '#c41a16' },
	'.cm-diagnostic-warning': { borderLeftColor: '#b8860b' }
})

// Map the engine's LSP positions (0-based line/character) onto CodeMirror
// document offsets, clamped to the live doc so a stale diagnostic can never
// throw. CodeMirror lines are 1-based; severities line up one-to-one.
function toCmDiagnostics(view: EditorView, diagnostics: Diagnostic[]): CmDiagnostic[] {
	const doc = view.state.doc
	const offset = (line: number, character: number) => {
		const row = doc.line(Math.min(Math.max(line, 0) + 1, doc.lines))
		return Math.min(row.from + Math.max(character, 0), row.to)
	}
	return diagnostics.map((d) => {
		const from = offset(d.range.start.line, d.range.start.character)
		const to = Math.max(offset(d.range.end.line, d.range.end.character), from)
		return {
			from,
			to,
			severity: d.severity,
			message: d.message,
			source: d.code ? `${d.source} ${d.code}` : d.source
		}
	})
}

// A CodeMirror editor driven imperatively: `setDoc` loads a freshly-read file
// and user edits are reported through `onChange`. Programmatic `setDoc` calls
// never fire `onChange`, so loading a file never echoes back as a save.
export function createEditor(onChange: (content: string) => void): Editor {
	let loading = false
	const view = new EditorView({
		doc: '',
		extensions: [
			basicSetup,
			lintGutter(),
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
		setDiagnostics(diagnostics) {
			view.dispatch(setDiagnostics(view.state, toCmDiagnostics(view, diagnostics)))
		},
		destroy() {
			view.destroy()
		}
	}
}
