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

injectStyle(
	`
.dict { display: flex; flex-direction: column; height: 100%; width: 100%; overflow: hidden; background: var(--window-bg); color: var(--text); font-family: var(--font-ui); }
.dict * { box-sizing: border-box; }

.dict-search { position: sticky; top: 0; z-index: 1; display: flex; gap: 8px; padding: 12px 16px; background: var(--surface); border-bottom: 1px solid var(--rule); }
.dict-input { flex: 1 1 auto; min-width: 0; font: inherit; font-size: 15px; padding: 7px 11px; color: inherit; background: var(--control-bg); border: 1px solid var(--rule); border-radius: 8px; }
.dict-input:focus-visible { outline: 2px solid var(--focus); outline-offset: -1px; }
.dict-submit { flex: 0 0 auto; font: inherit; font-size: 13px; padding: 7px 15px; cursor: default; color: var(--on-focus); background: var(--focus); border: 1px solid var(--focus); border-radius: 8px; }
.dict-search :disabled { opacity: 0.5; }

.dict-result { flex: 1 1 auto; overflow-y: auto; padding: 24px 20px 40px; }
.dict-placeholder { max-width: 34em; margin: 0; font-size: 13px; opacity: 0.55; }
.dict-placeholder + .dict-placeholder { margin-top: 8px; font-size: 12px; opacity: 0.45; }
.dict-error { max-width: 34em; display: flex; flex-direction: column; align-items: flex-start; gap: 10px; }
.dict-error p { margin: 0; font-size: 13px; color: color-mix(in oklab, #e5484d 78%, var(--text)); }
.dict-retry { font: inherit; font-size: 12px; padding: 4px 12px; cursor: default; color: inherit; background: var(--control-bg); border: 1px solid var(--rule); border-radius: 7px; }

.dict-entry { max-width: 40em; }
.dict-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--rule); }
.dict-headword { margin: 0; font-size: 34px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.1; }
.dict-phonetic { margin: 0; font-family: var(--font-mono); font-size: 14px; opacity: 0.55; }
.dict-meaning { margin-top: 22px; }
.dict-pos { margin: 0 0 10px; font-size: 13px; font-style: italic; font-weight: 600; opacity: 0.6; }
.dict-senses { margin: 0; padding-left: 1.4em; display: flex; flex-direction: column; gap: 14px; }
.dict-senses li::marker { font-size: 12px; opacity: 0.45; }
.dict-definition { margin: 0; font-size: 15px; line-height: 1.5; }
.dict-example { margin: 5px 0 0; padding-left: 10px; font-size: 14px; line-height: 1.5; opacity: 0.7; border-left: 2px solid var(--rule); }
.dict-gloss { margin: 3px 0 0; padding-left: 10px; font-size: 13px; line-height: 1.45; opacity: 0.5; border-left: 2px solid var(--rule); }
.dict-synonyms { display: flex; flex-wrap: wrap; gap: 5px; margin: 8px 0 0; padding: 0; list-style: none; }
.dict-synonyms li { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: color-mix(in oklab, var(--text) 8%, transparent); }

.dict-skeleton { max-width: 40em; display: flex; flex-direction: column; gap: 12px; }
.dict-bar { height: 13px; border-radius: 999px; background: color-mix(in oklab, var(--text) 11%, transparent); animation: dict-pulse 1.1s ease-in-out infinite; }
.dict-bar.is-head { height: 30px; width: 44%; }
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

		const input = el('input', 'dict-input')
		input.type = 'text'
		input.placeholder = 'Look up a word'
		input.spellcheck = false
		input.autocapitalize = 'none'
		input.setAttribute('aria-label', 'Word or short term')

		const submitButton = el('button', 'dict-submit', 'Look up')
		submitButton.type = 'submit'

		const form = el('form', 'dict-search', input, submitButton)
		const result = el('section', 'dict-result')
		root.classList.add('dict')
		root.replaceChildren(form, result)

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
			input.value = word
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
			if (notice) return el('p', 'dict-placeholder', notice)
			if (current.status === 'ready' && current.entry) return entryCard(current.entry)
			if (current.status === 'not-found')
				return el(
					'div',
					undefined,
					el('p', 'dict-placeholder', `No entry found for “${current.query}”.`),
					el(
						'p',
						'dict-placeholder',
						'This looks up words and short terms. For a question, ask the assistant.'
					)
				)
			if (current.status === 'error') {
				const retry = el('button', 'dict-retry', 'Try again')
				retry.type = 'button'
				retry.addEventListener('click', () => void lookup(current.query))
				return el(
					'div',
					'dict-error',
					el('p', undefined, current.error ?? 'The lookup failed.'),
					retry
				)
			}
			return el('p', 'dict-placeholder', 'Type a word to look it up.')
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
		render()

		return {
			update(next) {
				current = next ?? initialState
				// An agent-driven lookup lands here too: the entry simply appears.
				if (!pending) input.value ||= current.query
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
		'dict-head',
		el('h1', 'dict-headword', entry.word),
		entry.phonetic ? el('p', 'dict-phonetic', `/${entry.phonetic}/`) : null
	)
	const meanings = entry.meanings.map((meaning) =>
		el(
			'section',
			'dict-meaning',
			el('h2', 'dict-pos', meaning.partOfSpeech),
			el(
				'ol',
				'dict-senses',
				...meaning.senses.map((sense) =>
					el(
						'li',
						'dict-sense',
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
