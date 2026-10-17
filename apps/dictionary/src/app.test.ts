import { expect, test } from 'vitest'
import { app, type DictionaryState } from './app.ts'

// No app test harness exists yet (#276), so this is the smallest honest stand-in:
// the real reducer driven through the real `runProcedure`, with a hand-rolled
// handle that records capability calls. It proves the app's own behaviour —
// dispatch validation, transitions, staleness — not the kernel's.
type AiCall = { capability: string; method: string; args: unknown[] }

function driver(generate: (prompt: string) => Promise<string> | string) {
	let state: DictionaryState = app.initialState
	const calls: AiCall[] = []
	const handle = {
		get state() {
			return state
		},
		async dispatch(message: { type: string; params: unknown }) {
			const out = await app.dispatch(message, { state })
			if (out.state !== undefined) state = out.state as DictionaryState
			return { seq: 0 }
		},
		async settled() {
			return state
		},
		async invoke(capability: string, method: string, ...args: unknown[]) {
			calls.push({ capability, method, args })
			const input = args[0] as { prompt: string }
			return { text: await generate(input.prompt) }
		}
	}
	return {
		calls,
		get state() {
			return state
		},
		lookup: (word: string) =>
			// The bundle types this slot as the app's own typed handle; a fake returning
			// one shape for every capability method cannot satisfy that generic.
			app.runProcedure('lookup', { word }, handle as never),
		dispatch: (type: string, params: unknown) => handle.dispatch({ type, params })
	}
}

const ENTRY = {
	word: 'run',
	phonetic: 'rʌn',
	meanings: [
		{
			partOfSpeech: 'verb',
			senses: [{ definition: 'To move fast on foot.', example: 'They run home.' }]
		}
	]
}
const found = JSON.stringify({ found: true, entry: ENTRY })

test('the only capability is ai, scoped to the learning context', () => {
	expect(app.capabilities).toEqual({ ai: { id: 'ai', scopes: ['context:learning'] } })
})

test('a lookup asks for the learning context and commits the entry', async () => {
	const d = driver(() => found)
	await d.lookup('running')

	expect(d.calls).toHaveLength(1)
	const input = d.calls[0]?.args[0] as { context?: string; system?: string; prompt?: string }
	expect(d.calls[0]?.capability).toBe('ai')
	expect(input.context).toBe('learning')
	expect(input.prompt).toContain('Term: running')
	// The app supplies only its own task prompt; the reader's context is the
	// host's business and never comes back as data.
	expect(input.system).toContain("learner's dictionary")

	expect(d.state.status).toBe('ready')
	// The model resolves the lemma; the query keeps what was actually typed.
	expect(d.state.entry).toEqual(ENTRY)
	expect(d.state.query).toBe('running')
	expect(d.state.activeRequest).toBeNull()
	expect(JSON.stringify(d.state)).not.toContain('learning')
})

test('the word being looked up is committed before the answer arrives', async () => {
	let release = (_: string) => {}
	const d = driver(() => new Promise<string>((resolve) => (release = resolve)))
	const running = d.lookup('ephemeral')
	await new Promise((resolve) => setTimeout(resolve, 0))

	// What the agent can see mid-flight: the word, and that a lookup is open.
	expect(d.state.query).toBe('ephemeral')
	expect(d.state.activeRequest).not.toBeNull()
	expect(d.state.status).toBe('idle')

	release(found)
	await running
	expect(d.state.status).toBe('ready')
})

test('an explicit found:false is a missing word', async () => {
	const d = driver(() => '{"found": false}')
	await d.lookup('flurbish')
	expect(d.state.status).toBe('not-found')
	expect(d.state.entry).toBeNull()
	expect(d.state.error).toBeNull()
})

test('unreadable output is a retryable error, never a missing word', async () => {
	const d = driver(() => 'Sorry, I do not know that word.')
	await d.lookup('flurbish')
	expect(d.state.status).toBe('error')
	expect(d.state.error).toBeTruthy()
	expect(d.state.entry).toBeNull()
})

test('a failing model call is an error, and the query stays for a retry', async () => {
	const d = driver(() => Promise.reject(new Error('CAPABILITY_OFFLINE')))
	await d.lookup('ephemeral')
	expect(d.state.status).toBe('error')
	expect(d.state.error).toContain('CAPABILITY_OFFLINE')
	expect(d.state.query).toBe('ephemeral')
})

test('a stale answer cannot overwrite a newer lookup', async () => {
	const d = driver(() => found)
	await d.dispatch('begin', { query: 'first', requestId: 'r1' })
	await d.dispatch('begin', { query: 'second', requestId: 'r2' })

	await d.dispatch('shown', { requestId: 'r1', entry: ENTRY })
	expect(d.state).toMatchObject({ query: 'second', entry: null, activeRequest: 'r2' })
	await d.dispatch('missed', { requestId: 'r1' })
	expect(d.state.status).toBe('idle')

	await d.dispatch('shown', { requestId: 'r2', entry: ENTRY })
	expect(d.state).toMatchObject({ status: 'ready', activeRequest: null })
})

test('a non-term is refused before anything is committed', async () => {
	const d = driver(() => found)
	await expect(d.lookup('what does ephemeral mean?')).rejects.toThrow()
	expect(d.calls).toHaveLength(0)
	expect(d.state).toEqual(app.initialState)
})
