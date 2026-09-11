import type { StreamFn } from '@earendil-works/pi-agent-core'
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model
} from '@earendil-works/pi-ai'
import {
	type CapabilityCall,
	CapabilityError,
	capabilityRegistry
} from '@justfiles/app/capabilities'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { afterEach, expect, test, vi } from 'vitest'
import { aiCapability } from './ai.capability.ts'
import type { AgentBackend } from './llm.ts'

const encode = (text: string) => new TextEncoder().encode(text)
const decode = (data: Uint8Array) => new TextDecoder().decode(data)
const deferred = <T = void>() => Promise.withResolvers<T>()

function message(
	content: AssistantMessage['content'],
	stopReason: AssistantMessage['stopReason'] = 'stop'
): AssistantMessage {
	return {
		role: 'assistant',
		content,
		stopReason,
		api: 'test',
		provider: 'test',
		model: 'test',
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
		}
	}
}

function backend(steps: AssistantMessage[], before?: StreamFn): AgentBackend {
	return {
		model: { id: 'test' } as Model<Api>,
		revision: 'test',
		completeFn: async () => message([{ type: 'text', text: 'text unchanged' }]),
		streamFn: vi.fn(async (...args: Parameters<StreamFn>) => {
			await before?.(...args)
			const stream = createAssistantMessageEventStream()
			const msg = steps.shift() ?? message([{ type: 'text', text: 'done' }])
			stream.push({ type: 'done', reason: 'stop', message: msg })
			stream.end(msg)
			return stream
		})
	}
}
const tool = (name: string, args: Record<string, unknown>) =>
	message([{ type: 'toolCall', id: crypto.randomUUID(), name, arguments: args }], 'toolUse')
const use = (capability: string, method: string, ...args: unknown[]) =>
	tool('capability', { capability, method, args })
const write = (path: string, text: string) => use('files', 'writeFile', path, { $bytes: text })
const call = (
	method = 'runAgent',
	input: unknown = { requestId: 'one', prompt: 'research' },
	extra: Partial<CapabilityCall> = {}
): CapabilityCall => ({
	appId: 'app',
	capability: 'ai',
	method,
	args: [input],
	scopes: ['agent'],
	app: { bindings: {}, invoke: vi.fn() },
	...extra
})

function setup(steps: AssistantMessage[] = []) {
	const fs = volume(memStore())
	const model = backend(steps)
	const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('Page content'))
	const cap = aiCapability({
		volume: fs,
		generate: async () => 'text unchanged',
		agent: { backend: async () => model, fetch }
	})
	const bindings = {
		files: { id: 'volume', scopes: ['app'] },
		examples: { id: 'volume', scopes: ['/examples'] },
		inbox: { id: 'email', scopes: ['read'] }
	}
	const email = vi.fn(async () => [{ subject: 'hello' }])
	const caps = capabilityRegistry({
		volume: volumeCapability(fs),
		email: { invoke: email, subscribe: vi.fn() }
	})
	const app: NonNullable<CapabilityCall['app']> = {
		bindings,
		invoke: async (name, method, args) => {
			if (!Object.hasOwn(bindings, name))
				throw new CapabilityError('CAPABILITY_DENIED', name, method)
			const grant = bindings[name as keyof typeof bindings]
			return caps.invoke({ appId: 'app', capability: grant.id, scopes: grant.scopes, method, args })
		}
	}
	return { fs, model, fetch, cap, app, email }
}

afterEach(() => vi.useRealTimers())

test('research uses fresh context, with no workspace, memory or privileged tools', async () => {
	const { cap, model, fs } = setup([tool('fetch', { url: 'https://example.com' })])
	await fs.mkdir('/system')
	await fs.writeFile('/system/user.md', encode('SECRET USER CONTEXT'))
	expect(await cap.invoke(call())).toEqual({ text: 'done' })
	expect(await cap.invoke(call('generateText', { prompt: 'hello' }))).toEqual({
		text: 'text unchanged'
	})
	expect(await cap.invoke(call('runAgent', { requestId: 'two', prompt: 'fresh' }))).toEqual({
		text: 'done'
	})
	const contexts = vi.mocked(model.streamFn).mock.calls.map((args) => args[1])
	expect(contexts[0].tools?.map((t) => t.name)).toEqual(['search', 'fetch', 'capability'])
	expect(contexts[2].messages).toHaveLength(1)
	expect(JSON.stringify(contexts)).not.toContain('SECRET USER CONTEXT')
})

test('inherits all volume bindings and non-filesystem capabilities without a workspace argument', async () => {
	const { cap, fs, app, email, model } = setup([
		use('examples', 'readFile', '/sample.md'),
		write('/report/result.md', 'report'),
		write('/other/result.md', 'another workspace'),
		use('inbox', 'listUnread', { limit: 2 })
	])
	await fs.mkdir('/examples')
	await fs.writeFile('/examples/sample.md', encode('template'))
	expect(
		await cap.invoke(
			call(
				'runAgent',
				{ requestId: 'one', prompt: 'write in /report, following examples' },
				{ app }
			)
		)
	).toEqual({ text: 'done' })
	expect(decode(await fs.readFile('/data/app/report/result.md'))).toBe('report')
	expect(decode(await fs.readFile('/data/app/other/result.md'))).toBe('another workspace')
	expect(JSON.stringify(vi.mocked(model.streamFn).mock.calls)).toContain('template')
	expect(email).toHaveBeenCalledWith({
		appId: 'app',
		capability: 'email',
		scopes: ['read'],
		method: 'listUnread',
		args: [{ limit: 2 }]
	})
})

test('read-only page retrieval ignores raw options and checks every redirect protocol', async () => {
	const { cap, fetch, model } = setup([
		tool('fetch', {
			url: 'https://example.com',
			raw: true,
			method: 'DELETE',
			headers: { Authorization: 'secret' },
			body: 'delete'
		}),
		tool('fetch', { url: 'https://example.com/redirect' })
	])
	fetch
		.mockResolvedValueOnce(new Response('text'))
		.mockResolvedValueOnce(
			new Response(null, { status: 302, headers: { location: 'file:///private/secret' } })
		)
	await cap.invoke(call())
	expect(fetch).toHaveBeenCalledTimes(2)
	for (const [, options] of fetch.mock.calls)
		expect(options).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit' })
	expect(fetch.mock.calls[0][1]).not.toHaveProperty('headers')
	expect(fetch.mock.calls[0][1]).not.toHaveProperty('body')
	expect(JSON.stringify(vi.mocked(model.streamFn).mock.calls.at(-1)?.[1])).toContain(
		'Only public HTTP(S)'
	)
})

test('requires the agent scope and cannot inherit capabilities supplied in arguments', async () => {
	const { cap, model } = setup([use('files', 'readFile', '/secret')])
	await expect(cap.invoke(call(undefined, undefined, { scopes: [] }))).rejects.toMatchObject({
		code: 'CAPABILITY_DENIED'
	})
	await expect(
		cap.invoke(call('cancelAgent', { requestId: 'one' }, { scopes: [] }))
	).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
	await cap.invoke(
		call('runAgent', {
			requestId: 'one',
			prompt: 'read',
			app: { bindings: { files: { id: 'volume', scopes: ['system'] } } }
		})
	)
	expect(JSON.stringify(vi.mocked(model.streamFn).mock.calls)).toContain(
		'undeclared capability: files'
	)
})

test.each([
	null,
	{},
	{ requestId: '', prompt: 'x' },
	{ requestId: 'one', prompt: '' }
])('rejects invalid input %j', async (input) => {
	const { cap } = setup()
	await expect(cap.invoke(call('runAgent', input))).rejects.toMatchObject({
		code: 'CAPABILITY_INVALID_INPUT'
	})
})

test.each([
	'resolve',
	'reject'
] as const)('cancels backend setup even if the host ignores abort and later %ss', async (settle) => {
	const gate = deferred<AgentBackend>()
	const seen = deferred<AbortSignal>()
	const late = backend([])
	const resolveBackend = vi
		.fn(async (_signal: AbortSignal) => backend([]))
		.mockImplementationOnce(async (signal: AbortSignal) => {
			seen.resolve(signal)
			return gate.promise
		})
	const cap = aiCapability({
		generate: async () => '',
		agent: { backend: resolveBackend, fetch: vi.fn() }
	})
	const running = cap.invoke(call())
	const signal = await seen.promise
	await expect(cap.invoke(call())).rejects.toMatchObject({ code: 'CAPABILITY_FAILED' })
	expect(await cap.invoke(call('cancelAgent', { requestId: 'one' }, { appId: 'another' }))).toBe(
		false
	)
	expect(await cap.invoke(call('cancelAgent', { requestId: 'stale' }))).toBe(false)
	const cancel = cap.invoke(call('cancelAgent', { requestId: 'one' }))
	const repeat = cap.invoke(call('cancelAgent', { requestId: 'one' }))
	expect(await Promise.all([cancel, repeat])).toEqual([true, true])
	expect(signal.aborted).toBe(true)
	expect(await running).toEqual({ cancelled: true })
	expect(await cap.invoke(call('cancelAgent', { requestId: 'one' }))).toBe(false)
	expect(await cap.invoke(call('runAgent', { requestId: 'two', prompt: 'next' }))).toEqual({
		text: 'done'
	})
	if (settle === 'resolve') gate.resolve(late)
	else gate.reject(new Error('late setup failure'))
	await Promise.resolve()
	expect(late.streamFn).not.toHaveBeenCalled()
})

test('cancels an active tool, keeps completed writes, and starts no further tool', async () => {
	const { cap, fs, fetch, app } = setup([
		write('/saved.txt', 'saved\n'),
		tool('fetch', { url: 'https://example.com' }),
		write('/late.txt', 'late')
	])
	const started = deferred<AbortSignal>()
	fetch.mockImplementation(
		async (_, init) =>
			new Promise((_, reject) => {
				const signal = init!.signal!
				started.resolve(signal)
				signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
			})
	)
	const running = cap.invoke(call('runAgent', { requestId: 'one', prompt: 'write' }, { app }))
	const signal = await started.promise
	expect(await cap.invoke(call('cancelAgent', { requestId: 'one' }))).toBe(true)
	expect(await running).toEqual({ cancelled: true })
	expect(signal.aborted).toBe(true)
	expect(decode(await fs.readFile('/data/app/saved.txt'))).toBe('saved\n')
	expect(await fs.exists('/data/app/late.txt')).toBe(false)
})

test('a model failure rejects, and a later request gets a clean slot', async () => {
	const { cap } = setup([message([], 'error')])
	await expect(cap.invoke(call())).rejects.toMatchObject({ code: 'CAPABILITY_FAILED' })
	expect(await cap.invoke(call())).toEqual({ text: 'done' })
})

test('the 51st tool execution fails the run', async () => {
	const { cap, fetch } = setup(
		Array.from({ length: 51 }, () => tool('fetch', { url: 'https://example.com' }))
	)
	await expect(cap.invoke(call())).rejects.toMatchObject({ code: 'CAPABILITY_FAILED' })
	expect(fetch).toHaveBeenCalledTimes(50)
})

test('the ten-minute deadline is failure, not user cancellation', async () => {
	vi.useFakeTimers()
	const started = deferred()
	const cap = aiCapability({
		generate: async () => '',
		agent: {
			backend: () =>
				new Promise(() => {
					started.resolve()
				}),
			fetch: vi.fn()
		}
	})
	const result = expect(cap.invoke(call())).rejects.toMatchObject({ code: 'CAPABILITY_FAILED' })
	await started.promise
	await vi.advanceTimersByTimeAsync(600_000)
	await result
	expect(await cap.invoke(call('cancelAgent', { requestId: 'one' }))).toBe(false)
})

test('cancellation waits for an active capability call, keeps its write, and starts no further call', async () => {
	const { cap, fs, app } = setup([write('/slow', 'saved'), write('/late', 'late')])
	const started = deferred()
	const release = deferred()
	const invoke = app.invoke
	app.invoke = async (...args) => {
		started.resolve()
		await release.promise
		return invoke(...args)
	}
	const running = cap.invoke(call('runAgent', { requestId: 'one', prompt: 'write' }, { app }))
	await started.promise
	await cap.invoke(call('cancelAgent', { requestId: 'one' }))
	await expect(cap.invoke(call())).rejects.toMatchObject({ code: 'CAPABILITY_FAILED' })
	release.resolve()
	expect(await running).toEqual({ cancelled: true })
	expect(decode(await fs.readFile('/data/app/slow'))).toBe('saved')
	expect(await fs.exists('/data/app/late')).toBe(false)
})
