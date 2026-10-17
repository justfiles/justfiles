import { defineApp } from '@justfiles/app'
import { ai } from '@justfiles/app/capabilities/ai'
import * as v from 'valibot'
import {
	type Entry,
	entrySchema,
	lookupPrompt,
	normalizeTerm,
	parseLookupResult,
	systemPrompt
} from './lookup.ts'

// Status describes the LAST SETTLED lookup, never work in progress: a spinner is
// transient GUI business, and a persisted `looking-up` would come back from a
// reload as a lookup nothing is running any more. In-flight is `activeRequest !==
// null` alongside the already-committed `query`.
export type Status = 'idle' | 'ready' | 'not-found' | 'error'

// The whole app surface the agent reads. `query` is committed the moment a lookup
// STARTS, so a reader asking the agent "what does this actually mean?" mid-lookup
// is asking about a word the agent can already see. Nothing about the reader
// (age, interests, language context) is stored here — the host composes that
// privately behind `context: 'learning'` and it never comes back as data.
export type DictionaryState = {
	// Term as submitted, normalized (`Ice  Cream ` → `Ice Cream`).
	query: string
	// The resolved entry; `entry.word` is the model's lemma, so `running` → `run`.
	entry: Entry | null
	status: Status
	error: string | null
	// Opaque token for the newest lookup. Its only job is to let a slow answer
	// that has been overtaken land nowhere.
	activeRequest: string | null
}

export const initialState: DictionaryState = {
	query: '',
	entry: null,
	status: 'idle',
	error: null,
	activeRequest: null
}

// A settled answer applies only if it belongs to the newest lookup; a stale one
// leaves state untouched.
const settle = (
	state: DictionaryState,
	requestId: string,
	next: Partial<DictionaryState>
): DictionaryState =>
	state.activeRequest === requestId ? { ...state, ...next, activeRequest: null } : state

const requestSchema = v.object({ requestId: v.string() })

export const app = defineApp({
	init: initialState,
	// The one capability. `context:learning` lets `generateText` ask the host to
	// privately adapt its wording to the reader; the app declares the scope but
	// never sees the context. No volume, user, or network capability: an entry is
	// a live model answer and nothing is cached.
	capabilities: { ai: ai({ scopes: ['context:learning'] }) },
	// Every edge is internal: a lookup is inherently async, so the public surface
	// is the `lookup` procedure and these only commit its outcome.
	update: (t) => ({
		begin: t.commit(
			v.object({ query: v.string(), requestId: v.string() }),
			(state, { query, requestId }) => ({
				...state,
				query,
				entry: null,
				status: 'idle' as const,
				error: null,
				activeRequest: requestId
			})
		),
		shown: t.commit(
			v.object({ requestId: v.string(), entry: entrySchema }),
			(state, { requestId, entry }) =>
				settle(state, requestId, { entry, status: 'ready', error: null })
		),
		// Explicit `{"found": false}` only. Unreadable model output is `failed`.
		missed: t.commit(requestSchema, (state, { requestId }) =>
			settle(state, requestId, { entry: null, status: 'not-found', error: null })
		),
		failed: t.commit(
			v.object({ requestId: v.string(), message: v.pipe(v.string(), v.maxLength(200)) }),
			(state, { requestId, message }) =>
				settle(state, requestId, { entry: null, status: 'error', error: message })
		)
	}),
	procedures: (p) => ({
		lookup: p.procedure({
			description:
				'Look up a word or short lexical term and show a dictionary entry: meanings grouped by part of speech, numbered senses, and an example per sense. Words and short terms only — e.g. "ephemeral", "present", "ice cream" — never a question or a sentence.',
			schema: v.object({ word: v.string() }),
			async run({ word }, app) {
				// Throws for anything that is not a lexical term, before any commit:
				// the caller gets a plain action error and state is left alone.
				const query = normalizeTerm(word)
				const requestId = nextRequestId()
				const commit = async (type: string, params: Record<string, unknown>) =>
					app.settled((await app.dispatch({ type, params })).seq)

				await commit('begin', { query, requestId })
				try {
					const { text } = await app.cap.ai.generateText({
						context: 'learning',
						system: systemPrompt(),
						prompt: lookupPrompt(query)
					})
					const result = parseLookupResult(text)
					return result.found
						? await commit('shown', { requestId, entry: result.entry })
						: await commit('missed', { requestId })
				} catch (error) {
					return await commit('failed', { requestId, message: reason(error) })
				}
			}
		})
	})
})

const reason = (error: unknown): string =>
	(error instanceof Error ? error.message : String(error)).slice(0, 200)

// The reducer runs in an opaque-origin sandbox, which is not a secure context, so
// there is no `crypto.randomUUID`. A counter tells this instance's lookups apart;
// the random suffix keeps two kernels driving the same app (a GUI here, the agent
// on the server) from minting the same token. It is a dedupe tag, not a secret.
let requests = 0
const nextRequestId = () => `${++requests}-${Math.random().toString(36).slice(2, 8)}`

export type DictionaryApp = typeof app
