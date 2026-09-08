import { type AssistantMessage, createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { type AgentBackend, text } from '@justfiles/agent'
import { describeBackend, failureMessage } from '@justfiles/agent/remote'
import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { afterEach, expect, test, vi } from 'vitest'
import { createAiInference } from '../../frieren/worker/ai-inference.ts'
import { daemonAccounts } from './kernel.ts'
import { createPlatformAi } from './platform-ai.ts'

const model: AgentBackend['model'] = {
	id: 'test/model',
	api: 'openai-completions',
	provider: 'frieren',
	name: 'Test',
	reasoning: false,
	input: ['text'],
	contextWindow: 10000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	baseUrl: 'https://private-upstream',
	headers: { authorization: 'secret' }
}
const selection = { accountId: 'frieren', model: model.id, revision: '' }
const answer: AssistantMessage = {
	...failureMessage(model, ''),
	stopReason: 'stop',
	content: [{ type: 'text', text: 'hello' }],
	errorMessage: undefined
}
const backend: AgentBackend = {
	model,
	revision: 'v1',
	streamFn: () => {
		const stream = createAssistantMessageEventStream()
		stream.push({ type: 'text_delta', contentIndex: 0, delta: 'hello', partial: answer })
		stream.push({ type: 'done', reason: 'stop', message: answer })
		stream.end()
		return stream
	},
	completeFn: async () => answer
}
afterEach(() => vi.unstubAllGlobals())

function setup(resolve = async () => ({ backend, selection })) {
	const gateway = createAiInference(resolve)
	const calls: { path: string; token: string | null; body?: unknown }[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string | URL, init?: RequestInit) => {
			const path = new URL(url).pathname.replace('/api/ai', '')
			calls.push({
				path,
				token: new Headers(init?.headers).get('authorization'),
				body: init?.body ? JSON.parse(String(init.body)) : undefined
			})
			return gateway.request(`http://test${path}`, init)
		})
	)
	let n = 0
	return {
		calls,
		gateway,
		getBackend: createPlatformAi({
			origin: 'https://cloud.example',
			getToken: async () => `token-${++n}`
		})
	}
}

test('uses cloud selection and fresh platform tokens without exposing provider secrets', async () => {
	const { getBackend, calls } = setup()
	const remote = (await getBackend())!
	expect(remote.model.baseUrl).toBe('')
	expect(remote.model.headers).toBeUndefined()
	expect(await text(remote).gen('Be brief', 'Hello')).toBe('hello')
	expect(await text(remote).gen('Be brief', 'Again')).toBe('hello')
	expect(calls.map((r) => r.token)).toEqual(['Bearer token-1', 'Bearer token-2', 'Bearer token-3'])
	expect(calls[1].body).toMatchObject({ selection, context: { systemPrompt: 'Be brief' } })
	expect(JSON.stringify(describeBackend(backend, selection))).not.toContain('secret')
})

test('signed-out Mac keeps local accounts and has no inference backend', async () => {
	const accounts = daemonAccounts(volume(memStore()), { getToken: async () => null })
	expect(await accounts.resolveBackend()).toBeNull()
	expect((await accounts.admin.listProviders({})).map((p) => p.id)).toEqual(['google', 'icloud'])
	expect(
		await accounts.remote.invoke({
			appId: 'justfiles.settings',
			capability: 'settings',
			method: 'accounts.listAccounts',
			args: [{}],
			scopes: []
		})
	).toEqual([])
	accounts.dispose()
})

test('a removed credential rejects a pinned request instead of selecting the built-in provider', async () => {
	let removed = false
	const { getBackend } = setup(async () => {
		if (removed) throw new Error('removed')
		return { backend, selection }
	})
	const remote = (await getBackend())!
	removed = true
	const result = await remote.completeFn(remote.model, { messages: [] })
	expect(result.stopReason).toBe('error')
	expect(result.errorMessage).toContain('account changed')
})

test('a truncated stream settles with an error rather than hanging', async () => {
	const { getBackend } = setup()
	const remote = (await getBackend())!
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response('', { headers: { 'content-type': 'application/x-ndjson' } }))
	)
	const result = await remote.completeFn(remote.model, { messages: [] })
	expect(result.stopReason).toBe('error')
	expect(result.errorMessage).toContain('before completing')
})

test('gateway rejects client-supplied credentials and upstream overrides', async () => {
	const { gateway } = setup()
	const response = await gateway.request('http://test/infer', {
		method: 'POST',
		body: JSON.stringify({
			version: 1,
			selection,
			context: { messages: [] },
			options: { headers: { authorization: 'bad' }, apiKey: 'bad' }
		})
	})
	expect(response.status).toBe(400)
})

test('tool calls and results cross the transport; execution stays with the caller', async () => {
	const tool: AssistantMessage = {
		...answer,
		stopReason: 'toolUse',
		content: [{ type: 'toolCall', id: 'call-1', name: 'read_file', arguments: { path: '/notes' } }]
	}
	const received: unknown[] = []
	const harness: AgentBackend = {
		...backend,
		streamFn: (_model, context) => {
			received.push(context)
			const message = context.messages.some((m) => m.role === 'toolResult') ? answer : tool
			const stream = createAssistantMessageEventStream()
			stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message })
			stream.end()
			return stream
		}
	}
	const { getBackend } = setup(async () => ({ backend: harness, selection }))
	const remote = (await getBackend())!
	const first = await remote.completeFn(remote.model, {
		messages: [{ role: 'user', content: 'Read my note', timestamp: 1 }]
	})
	expect(first.content).toEqual(tool.content)
	const final = await remote.completeFn(remote.model, {
		messages: [
			first,
			{
				role: 'toolResult',
				toolCallId: 'call-1',
				toolName: 'read_file',
				content: [{ type: 'text', text: 'local contents' }],
				isError: false,
				timestamp: 2
			}
		]
	})
	expect(final.content).toEqual(answer.content)
	expect(received[1]).toMatchObject({
		messages: [
			JSON.parse(JSON.stringify(tool)),
			{ role: 'toolResult', content: [{ text: 'local contents' }] }
		]
	})
})

test('cancelling the response body aborts the upstream inference', async () => {
	let upstream: AbortSignal | undefined
	const pending: AgentBackend = {
		...backend,
		streamFn: (_model, _context, options) => {
			upstream = options?.signal
			const events = createAssistantMessageEventStream()
			events.push({ type: 'start', partial: answer })
			upstream?.addEventListener(
				'abort',
				() => {
					events.push({
						type: 'error',
						reason: 'aborted',
						error: { ...answer, stopReason: 'aborted' }
					})
					events.end()
				},
				{ once: true }
			)
			return events
		}
	}
	const { gateway } = setup(async () => ({ backend: pending, selection }))
	const response = await gateway.request('http://test/infer', {
		method: 'POST',
		body: JSON.stringify({ version: 1, selection, context: { messages: [] } })
	})
	const reader = response.body!.getReader()
	await reader.read()
	await reader.cancel()
	await vi.waitFor(() => expect(upstream?.aborted).toBe(true))
})

test('an already-aborted caller settles with the aborted stop reason', async () => {
	const { getBackend } = setup()
	const remote = (await getBackend())!
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url, options: RequestInit) => {
			options.signal!.throwIfAborted()
			throw new Error('unexpected')
		})
	)
	const abort = new AbortController()
	abort.abort()
	const result = await remote.completeFn(remote.model, { messages: [] }, { signal: abort.signal })
	expect(result.stopReason).toBe('aborted')
})
