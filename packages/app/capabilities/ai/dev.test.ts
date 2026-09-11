import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, test, vi } from 'vitest'
import type { Capability } from '../types.ts'
import { devAiCapability, devAiForApp, resolveDevAi } from './dev.ts'

type TestDeps = NonNullable<Parameters<typeof resolveDevAi>[1]>

function testDeps(overrides: Partial<TestDeps> = {}): TestDeps {
	return {
		env: { PATH: '' },
		which: vi.fn(() => false),
		fetch: vi.fn(async () => {
			throw new Error('offline')
		}) as unknown as typeof fetch,
		spawn: vi.fn() as unknown as TestDeps['spawn'],
		...overrides
	}
}

function invoke(capability: Capability, input: unknown, scopes: string[] = []) {
	return capability.invoke({
		appId: 'app.test',
		capability: 'ai',
		method: 'generateText',
		args: [input],
		scopes
	})
}

test('a function backend is used as-is', async () => {
	const generate = vi.fn(async () => 'answer')
	const resolved = await resolveDevAi(generate, testDeps())

	expect(resolved?.generate).toBe(generate)
})

test('auto follows the fixed CLI order', async () => {
	const which = vi.fn((command: string) => command === 'claude')
	const resolved = await resolveDevAi('auto', testDeps({ which }))

	expect(resolved?.name).toBe('claude-cli')
	expect(which.mock.calls.map(([command]) => command)).toEqual(['pi', 'claude'])
})

test('auto with no backend returns a hint and no capability', async () => {
	const use = testDeps()
	const setup = await devAiForApp('app.test', { ai: { id: 'ai', scopes: [] } }, 'auto', use)

	expect(setup.capability).toBeUndefined()
	expect(setup.message).toContain('no supported local backend found')
	expect(use.fetch).toHaveBeenCalledTimes(2)
})

test('a missing pinned CLI names the fix', async () => {
	await expect(resolveDevAi('pi-cli', testDeps())).rejects.toThrow(
		'Install it or use devAi() to select an installed backend'
	)
})

test('a CLI failure can report its message on stdout', async () => {
	const spawn = vi.fn(() => {
		const child = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough()
		})
		queueMicrotask(() => {
			child.stdout.end('monthly spend limit reached')
			child.stderr.end()
			child.emit('close', 1)
		})
		return child
	}) as unknown as TestDeps['spawn']
	const resolved = await resolveDevAi('claude-cli', testDeps({ spawn, which: () => true }))

	await expect(resolved?.generate({ system: '', prompt: 'Hello' })).rejects.toThrow(
		'monthly spend limit reached'
	)
})

test('an HTTP backend reads one model and posts one completion', async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(
			new Response(JSON.stringify({ data: [{ id: 'local-model' }] }), { status: 200 })
		)
		.mockResolvedValueOnce(
			new Response(JSON.stringify({ choices: [{ message: { content: 'local answer' } }] }), {
				status: 200
			})
		) as unknown as typeof globalThis.fetch
	const resolved = await resolveDevAi('http://localhost:11434/v1', testDeps({ fetch }))
	const text = await resolved?.generate({
		system: 'Be brief.',
		prompt: 'Hello',
		temperature: 0.2,
		maxTokens: 50
	})

	expect(text).toBe('local answer')
	expect(fetch).toHaveBeenCalledTimes(2)
	expect(fetch).toHaveBeenNthCalledWith(1, 'http://localhost:11434/v1/models', {
		signal: undefined
	})
	const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1] ?? []
	expect(url).toBe('http://localhost:11434/v1/chat/completions')
	expect(init).toMatchObject({ method: 'POST' })
	expect(JSON.parse(String(init?.body))).toEqual({
		model: 'local-model',
		messages: [
			{ role: 'system', content: 'Be brief.' },
			{ role: 'user', content: 'Hello' }
		],
		temperature: 0.2,
		max_tokens: 50
	})
})

test('an unknown backend lists the valid forms', async () => {
	await expect(resolveDevAi('local-magic', testDeps())).rejects.toThrow(
		'Use "pi-cli", "claude-cli", "codex-cli", an HTTP URL, or a function'
	)
})

test('learning context needs its declared scope', async () => {
	const capability = devAiCapability(async () => 'answer')

	await expect(invoke(capability, { context: 'learning', prompt: 'Hello' })).rejects.toMatchObject({
		code: 'CAPABILITY_DENIED'
	})
})

test('learning context passes the request through without a projection', async () => {
	const generate = vi.fn(async () => 'answer')
	const capability = devAiCapability(generate)

	await expect(
		invoke(capability, { context: 'learning', system: 'System', prompt: 'Hello', maxTokens: 10 }, [
			'context:learning'
		])
	).resolves.toEqual({ text: 'answer' })
	expect(generate).toHaveBeenCalledWith({
		system: 'System',
		prompt: 'Hello',
		temperature: undefined,
		maxTokens: 10
	})
})

test('an unknown context is invalid input', async () => {
	const capability = devAiCapability(async () => 'answer')

	await expect(invoke(capability, { context: 'private', prompt: 'Hello' })).rejects.toMatchObject({
		code: 'CAPABILITY_INVALID_INPUT'
	})
})

test('an app without ai runs no probe and gets no capability', async () => {
	const use = testDeps()
	const setup = await devAiForApp('app.test', { files: { id: 'volume', scopes: [] } }, 'auto', use)

	expect(setup).toEqual({})
	expect(use.which).not.toHaveBeenCalled()
	expect(use.fetch).not.toHaveBeenCalled()
})

test('a backend failure keeps its message and uses CAPABILITY_FAILED', async () => {
	const capability = devAiCapability(async () => {
		throw new Error('model is not configured')
	})

	await expect(invoke(capability, { prompt: 'Hello' })).rejects.toMatchObject({
		code: 'CAPABILITY_FAILED',
		message: 'model is not configured'
	})
})

test('a missing plugin reports the installed backends', async () => {
	const setup = await devAiForApp(
		'alice.notes',
		{ ai: { id: 'ai', scopes: [] } },
		undefined,
		testDeps({ which: (command) => command === 'pi' || command === 'codex' })
	)

	expect(setup.message).toBe(
		'ai: `alice.notes` declares the `ai` capability but no dev backend is configured.\n' +
			'    Found `pi` and `codex`. Add `devAi()` to the plugins in vite.config.ts.'
	)
})

test.each([
	'runAgent',
	'cancelAgent'
])('text-only dev AI explicitly declines %s', async (method) => {
	const capability = devAiCapability(async () => 'text')
	await expect(
		capability.invoke({
			appId: 'app.test',
			capability: 'ai',
			method,
			args: [{ requestId: 'one', prompt: 'task' }],
			scopes: ['agent']
		})
	).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE', method })
})
