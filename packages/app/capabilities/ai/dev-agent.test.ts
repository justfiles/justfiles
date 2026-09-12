import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { expect, test, vi } from 'vitest'
import { devAiForApp, type GenerateText } from './dev.ts'
import { agentResolver } from './dev-agent.ts'
import type { Deps } from './dev-text.ts'

const help = '--safe-mode --tools --strict-mcp-config --no-session-persistence --json-schema'
function answer(prompt: string) {
	const { messages } = JSON.parse(prompt)
	const last = messages.at(-1)
	return last.role === 'toolResult'
		? { type: 'final', text: last.content[0].text }
		: { type: 'tool_call', name: 'lookupFixture', arguments: {} }
}
function deps(
	output: (prompt: string) => string = (prompt) =>
		JSON.stringify({
			type: 'result',
			subtype: 'success',
			structured_output: answer(prompt)
		})
): Deps {
	return {
		env: { PATH: '' },
		which: vi.fn(() => true),
		fetch: vi.fn(),
		spawn: vi.fn((_command, args, options) => {
			const child = Object.assign(new EventEmitter(), {
				stdin: new PassThrough(),
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				kill: vi.fn(() => {
					queueMicrotask(() => child.emit('close', 143))
					return true
				})
			})
			let input = ''
			child.stdin.on('data', (data) => {
				input += data
			})
			child.stdin.on('finish', () =>
				queueMicrotask(() => {
					try {
						child.stdout.end(args.includes('--help') ? help : output(input))
						child.emit('close', 0)
					} catch (error) {
						child.stderr.end(String(error))
						child.emit('close', 1)
					}
				})
			)
			if (!args.includes('--help')) {
				expect(args).toEqual(
					expect.arrayContaining([
						'--tools',
						'',
						'--safe-mode',
						'--strict-mcp-config',
						'--no-session-persistence',
						'--json-schema'
					])
				)
				expect(existsSync(options.cwd)).toBe(true)
			}
			return child
		}) as unknown as Deps['spawn']
	}
}

test('auto skips installed unsupported CLIs and caches the verified Claude backend', async () => {
	const use = deps()
	const resolver = agentResolver('auto', use)
	const signal = new AbortController().signal
	const first = await resolver.backend(signal)
	expect(first.model.id).toBe('claude-cli')
	expect(await resolver.backend(signal)).toBe(first)
	expect(use.spawn).toHaveBeenCalledTimes(3)
	for (const [, , options] of vi.mocked(use.spawn).mock.calls)
		if (options?.cwd) expect(existsSync(String(options.cwd))).toBe(false)
})

test('explicit backend failures retain readiness diagnostics and are cached', async () => {
	const use = deps(() => {
		throw new Error('login failed: invalid_refresh_token')
	})
	const resolver = agentResolver('claude-cli', use)
	for (let i = 0; i < 2; i++)
		await expect(resolver.backend(new AbortController().signal)).rejects.toThrow(
			'invalid_refresh_token'
		)
	expect(use.spawn).toHaveBeenCalledTimes(2)
	const missing = deps()
	missing.which = () => false
	await expect(
		agentResolver('claude-cli', missing).backend(new AbortController().signal)
	).rejects.toThrow('missing executable')
})

test('text-only functions decline agent support; explicit abort-aware functions pass the same probe', async () => {
	const text: GenerateText = async () => 'ordinary text'
	await expect(agentResolver(text, deps()).backend(new AbortController().signal)).rejects.toThrow(
		'abort-aware'
	)
	text.agent = async ({ prompt, signal }) => {
		signal.throwIfAborted()
		return JSON.stringify(answer(prompt))
	}
	expect((await agentResolver(text, deps()).backend(new AbortController().signal)).model.id).toBe(
		'custom'
	)
})

test('HTTP supports the same tool loop, forwards abort, and discovers the model once', async () => {
	const use = deps()
	use.fetch = vi.fn(async (url, init) => {
		expect(init?.signal).toBeInstanceOf(AbortSignal)
		return new Response(
			JSON.stringify(
				String(url).endsWith('/models')
					? { data: [{ id: 'test' }] }
					: {
							choices: [
								{
									message: {
										content: JSON.stringify(
											answer(JSON.parse(String(init?.body)).messages[1].content)
										)
									}
								}
							]
						}
			)
		)
	})
	await agentResolver('http://localhost:11434/v1', use).backend(new AbortController().signal)
	expect(use.fetch).toHaveBeenCalledTimes(3)
})

test('cancellation during readiness holds the app slot until transport settles, and permits retry', async () => {
	const started = Promise.withResolvers<AbortSignal>()
	const release = Promise.withResolvers<void>()
	const generate = Object.assign(async () => 'text', {
		agent: vi.fn(async ({ signal }) => {
			started.resolve(signal)
			await release.promise
			return '{"type":"final","text":"late"}'
		})
	})
	const { capability } = await devAiForApp(
		'app',
		{ ai: { id: 'ai', scopes: ['agent'] } },
		generate,
		deps()
	)
	const call = (method: string, requestId = 'one') =>
		capability!.invoke({
			appId: 'app',
			capability: 'ai',
			method,
			args: [{ requestId, prompt: 'task' }],
			scopes: ['agent'],
			app: { bindings: {}, invoke: vi.fn() }
		})
	const running = call('runAgent')
	const signal = await started.promise
	expect(await call('cancelAgent')).toBe(true)
	expect(signal.aborted).toBe(true)
	await expect(call('runAgent', 'two')).rejects.toMatchObject({ code: 'CAPABILITY_FAILED' })
	release.resolve()
	expect(await running).toEqual({ cancelled: true })
	generate.agent.mockImplementation(async ({ prompt }) => JSON.stringify(answer(prompt)))
	await expect(call('runAgent', 'two')).rejects.toMatchObject({ code: 'CAPABILITY_FAILED' })
	// The new task reaches its own model turn after a fresh, successful readiness check.
	expect(generate.agent).toHaveBeenCalledTimes(4)
	await capability!.dispose()
})

test('auto falls through a login failure to a verified HTTP backend', async () => {
	const use = deps(() => {
		throw new Error('login failed')
	})
	use.fetch = vi.fn(
		async (url, init) =>
			new Response(
				JSON.stringify(
					String(url).endsWith('/models')
						? { data: [{ id: 'test' }] }
						: {
								choices: [
									{
										message: {
											content: JSON.stringify(
												answer(JSON.parse(String(init?.body)).messages[1].content)
											)
										}
									}
								]
							}
				)
			)
	)
	use.log = vi.fn()
	expect((await agentResolver('auto', use).backend(new AbortController().signal)).model.id).toBe(
		'http://localhost:11434/v1'
	)
	expect(use.log).toHaveBeenCalledWith(expect.stringContaining('login failed'))
})

test('readiness has a bounded timeout and caches the failure', async () => {
	vi.useFakeTimers()
	const started = Promise.withResolvers<void>()
	const agent = vi.fn(
		async ({ signal }) =>
			new Promise<string>((_, reject) => {
				started.resolve()
				signal.addEventListener('abort', () => reject(signal.reason), { once: true })
			})
	)
	const resolver = agentResolver(
		Object.assign(async () => 'text', { agent }),
		deps()
	)
	try {
		const result = expect(resolver.backend(new AbortController().signal)).rejects.toThrow(
			'timed out'
		)
		await started.promise
		await vi.advanceTimersByTimeAsync(60_000)
		await result
		await expect(resolver.backend(new AbortController().signal)).rejects.toThrow('timed out')
		expect(agent).toHaveBeenCalledTimes(1)
	} finally {
		vi.useRealTimers()
	}
})
