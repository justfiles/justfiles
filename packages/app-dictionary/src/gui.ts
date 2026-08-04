// A framework-free GUI: plain DOM through `defineGUI`. The layout is split in
// two on purpose — chrome (the search field) is built ONCE in `mount` and never
// touched again, so focus, caret, and selection survive; only the result region
// is rebuilt on each state push. That split is what React's reconciliation would
// otherwise be buying us here.
//
// Everything is built with `append`, never `innerHTML`, so model-authored text is
// inserted as text nodes and can never be parsed as markup.
import { defineGUI, injectStyle } from '@justfiles/app/browser'
import { type DictionaryApp, type DictionaryState, initialState } from './app.ts'
import { type Entry, normalizeTerm, READER_LANGUAGE } from './lookup.ts'

// Layout and the dictionary's own typographic hierarchy — nothing else. Controls
// are bare `<input>`/`<button>`: the host's platform sheet (mac.css, injected
// into this frame) already styles them, and every colour here is a design token,
// so dark mode follows for free. Type sizes are em-relative so they track
// `--text-ui` rather than pinning their own scale.
injectStyle(
	`
.dict { display: flex; flex-direction: column; height: 100%; width: 100%; }

.dict-search { flex: none; display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: var(--surface); border-bottom: 1px solid var(--rule); }
.dict-search input { flex: 1; min-width: 0; }

.dict-result { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 18px; }
.dict-note { max-width: 34em; margin: 0 0 6px; opacity: 0.55; }
.dict-error { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; max-width: 34em; }
.dict-error p { margin: 0; color: var(--danger); }

/* A headword, its part of speech, and numbered senses: a shape the design system
   has no component for, so it lives here. */
.dict-entry { max-width: 34em; }
.dict-entry header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--rule); }
.dict-entry h1 { margin: 0; font-size: 2.2em; font-weight: 600; letter-spacing: -0.02em; }
.dict-entry h2 { margin: 16px 0 8px; font-size: 1em; font-style: italic; font-weight: 600; opacity: 0.6; }
.dict-entry ol { margin: 0; padding-left: 1.6em; display: flex; flex-direction: column; gap: 10px; }
.dict-entry li::marker { opacity: 0.45; }
.dict-phonetic { margin: 0; font-family: var(--font-mono); opacity: 0.55; }
.dict-definition { margin: 0; }
.dict-example, .dict-gloss { margin: 4px 0 0; padding-left: 8px; border-left: 1px solid var(--rule); opacity: 0.7; }
.dict-gloss { opacity: 0.5; }
.dict-synonyms { display: flex; flex-wrap: wrap; gap: 4px; margin: 7px 0 0; padding: 0; list-style: none; }
.dict-synonyms li { font-size: 0.85em; padding: 1px 8px; background: var(--control-bg); border: 1px solid var(--rule); border-radius: 999px; }

.dict-skeleton { display: flex; flex-direction: column; gap: 10px; max-width: 34em; }
.dict-bar { height: 12px; border-radius: 999px; background: var(--rule); animation: dict-pulse 1.1s ease-in-out infinite; }
.dict-bar.is-head { height: 26px; width: 44%; }
.dict-bar.is-short { width: 62%; }
@keyframes dict-pulse { 50% { opacity: 0.4; } }
`,
	'app-dictionary'
)

type Kid = Node | string | null | undefined

const el = <K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	...kids: Kid[]
): HTMLElementTagNameMap[K] => {
	const node = document.createElement(tag)
	if (className) node.className = className
	for (const kid of kids) if (kid != null) node.append(kid)
	return node
}

const reason = (error: unknown): string =>
	error instanceof Error ? error.message : 'Something went wrong.'

export const gui = defineGUI<DictionaryApp>({
	mount(root, state, { client }) {
		let current: DictionaryState = state ?? initialState
		// Transient, GUI-only: a lookup in flight and a message about what the
		// reader just typed. Neither belongs in persisted, agent-visible state.
		let pending = false
		let notice: string | null = null

		const input = el('input')
		input.type = 'text'
		input.placeholder = 'Look up a word'
		input.spellcheck = false
		input.autocapitalize = 'none'
		input.setAttribute('aria-label', 'Word or short term')

		const submitButton = el('button', undefined, 'Look up')
		submitButton.type = 'submit'
		// The default button: Return in the field fires exactly this.
		submitButton.dataset.primary = 'true'

		const form = el('form', 'dict-search', input, submitButton)
		const result = el('section', 'dict-result')
		root.classList.add('dict')
		root.replaceChildren(form, result)

		// The field follows the committed query — including a lookup the AGENT ran —
		// unless the reader has an unsent edit in it, which is theirs to keep.
		let edited = false
		const setField = (value: string) => {
			input.value = value
			edited = false
		}
		input.addEventListener('input', () => {
			edited = true
		})

		form.addEventListener('submit', (event) => {
			event.preventDefault()
			void lookup(input.value)
		})

		async function lookup(raw: string): Promise<void> {
			if (pending) return
			let word: string
			try {
				word = normalizeTerm(raw)
			} catch (error) {
				notice = reason(error)
				render()
				return
			}
			setField(word)
			notice = null
			pending = true
			render()
			try {
				await client.lookup({ word })
			} catch (error) {
				notice = reason(error)
			} finally {
				pending = false
				render()
				input.focus()
			}
		}

		function render(): void {
			input.disabled = pending
			submitButton.disabled = pending
			result.replaceChildren(body())
		}

		function body(): Node {
			if (pending) return skeleton()
			if (notice) return el('p', 'dict-note', notice)
			if (current.status === 'ready' && current.entry) return entryCard(current.entry)
			if (current.status === 'not-found')
				return el(
					'div',
					undefined,
					el('p', 'dict-note', `No entry found for “${current.query}”.`),
					el(
						'p',
						'dict-note',
						'This looks up words and short terms. For a question, ask the assistant.'
					)
				)
			if (current.status === 'error') {
				const retry = el('button', undefined, 'Try again')
				retry.type = 'button'
				retry.addEventListener('click', () => void lookup(current.query))
				return el(
					'div',
					'dict-error',
					el('p', undefined, current.error ?? 'The lookup failed.'),
					retry
				)
			}
			return el('p', 'dict-note', 'Type a word to look it up.')
		}

		function skeleton(): Node {
			return el(
				'div',
				'dict-skeleton',
				el('div', 'dict-bar is-head'),
				el('div', 'dict-bar'),
				el('div', 'dict-bar is-short')
			)
		}

		requestAnimationFrame(() => input.focus())
		setField(current.query)
		render()

		return {
			update(next) {
				current = next ?? initialState
				// An agent-driven lookup lands here too: the entry appears and the field
				// catches up, so submitting again repeats THIS word, not a stale one.
				if (!pending && !edited) setField(current.query)
				render()
			},
			unmount() {
				root.classList.remove('dict')
				root.replaceChildren()
			}
		}
	}
})

// Headword, IPA, then one section per part of speech with numbered senses. An
// example belongs to its sense, so it is nested in the list item rather than
// collected into a detached list at the bottom.
function entryCard(entry: Entry): Node {
	const head = el(
		'header',
		undefined,
		el('h1', undefined, entry.word),
		entry.phonetic ? el('p', 'dict-phonetic', `/${entry.phonetic}/`) : null
	)
	const meanings = entry.meanings.map((meaning) =>
		el(
			'section',
			undefined,
			el('h2', undefined, meaning.partOfSpeech),
			el(
				'ol',
				undefined,
				...meaning.senses.map((sense) =>
					el(
						'li',
						undefined,
						el('p', 'dict-definition', sense.definition),
						sense.example ? el('p', 'dict-example', `“${sense.example}”`) : null,
						// The example is in the headword's language; this is its
						// gloss when that is not the reader's language.
						sense.exampleTranslation
							? el('p', 'dict-gloss', `${READER_LANGUAGE}: ${sense.exampleTranslation}`)
							: null,
						sense.synonyms?.length
							? el(
									'ul',
									'dict-synonyms',
									...sense.synonyms.map((synonym) => el('li', undefined, synonym))
								)
							: null
					)
				)
			)
		)
	)
	return el('article', 'dict-entry', head, ...meanings)
}
