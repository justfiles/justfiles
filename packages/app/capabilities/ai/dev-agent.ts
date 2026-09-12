import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '@earendil-works/pi-agent-core'
import Type from 'typebox'
import type { AgentBackend } from './agent/backend.ts'
import { type AgentText, textBackend } from './agent/text.ts'
import { run } from './dev-process.ts'
import { type AiBackend, CLI, type Deps, isHttpUrl, LOCAL_SERVERS, openAi } from './dev-text.ts'

export function agentResolver(selection: AiBackend, use: Deps) {
	let cached: AgentBackend | Error | undefined
	const pending = new Map<AbortSignal, Promise<unknown>>()
	return {
		backend(signal: AbortSignal): Promise<AgentBackend> {
			signal.throwIfAborted()
			if (cached instanceof Error) return Promise.reject(cached)
			if (cached) return Promise.resolve(cached)
			const work = resolveAgent(selection, use, signal).then(
				(backend) => (cached = backend),
				(error) => {
					if (!signal.aborted) cached = error instanceof Error ? error : new Error(String(error))
					throw error
				}
			)
			pending.set(signal, work)
			void work.finally(() => pending.delete(signal)).catch(() => {})
			return work
		},
		async drain(signal: AbortSignal) {
			await pending.get(signal)?.catch(() => {})
		}
	}
}

async function resolveAgent(selection: AiBackend, use: Deps, signal: AbortSignal) {
	const candidates = selection === 'auto' ? [...Object.keys(CLI), ...LOCAL_SERVERS] : [selection]
	const errors: string[] = []
	for (const candidate of candidates) {
		signal.throwIfAborted()
		const name = typeof candidate === 'function' ? 'custom' : candidate
		const stop = new AbortController()
		const timer = setTimeout(
			() => stop.abort(new Error('readiness check timed out after 60 seconds')),
			60_000
		)
		const probeSignal = AbortSignal.any([signal, stop.signal])
		try {
			const generate = await transport(candidate, use, probeSignal)
			const backend = textBackend(name, generate)
			await probe(backend, probeSignal)
			signal.throwIfAborted()
			use.log?.(`ai agent: ${name}`)
			return backend
		} catch (error) {
			signal.throwIfAborted()
			const reason = `${name}: ${String(error instanceof Error ? error.message : error).slice(0, 500)}`
			errors.push(reason)
			if (selection === 'auto') use.log?.(`ai agent: skipped ${reason}`)
		} finally {
			clearTimeout(timer)
		}
	}
	throw new Error(`No usable agent backend. ${errors.join('; ')}`)
}

async function transport(candidate: AiBackend, use: Deps, signal: AbortSignal): Promise<AgentText> {
	if (typeof candidate === 'function') {
		if (!candidate.agent)
			throw new Error('text function needs an explicit abort-aware .agent function')
		return candidate.agent
	}
	if (isHttpUrl(candidate)) return openAi(candidate, use.fetch)
	if (!Object.hasOwn(CLI, candidate)) throw new Error('unknown backend')
	const command = CLI[candidate as keyof typeof CLI]
	if (!use.which(command, use.env)) throw new Error(`missing executable: ${command}`)
	if (candidate !== 'claude-cli')
		throw new Error(
			'unsupported agent mode: isolation and authenticated round trip have not been verified; use claude-cli'
		)
	if (process.platform === 'win32')
		throw new Error('agent process cleanup currently requires macOS or Linux')
	const help = await run(use, command, ['--safe-mode', '--help'], '', { signal })
	for (const flag of [
		'--safe-mode',
		'--tools',
		'--strict-mcp-config',
		'--no-session-persistence',
		'--json-schema'
	])
		if (!help.includes(flag))
			throw new Error(`unsupported CLI mode: missing ${flag}; update Claude Code`)
	return async ({ system, prompt, signal }) => {
		const cwd = await mkdtemp(join(tmpdir(), 'justfiles-agent-'))
		try {
			return await run(
				use,
				command,
				[
					'-p',
					'--tools',
					'',
					'--strict-mcp-config',
					'--safe-mode',
					'--no-session-persistence',
					'--output-format',
					'json',
					// Claude rejects unions at the schema root; the shared codec checks the full response.
					'--json-schema',
					JSON.stringify({
						type: 'object',
						properties: {
							type: { type: 'string', enum: ['tool_call', 'final'] },
							text: { type: 'string' },
							name: { type: 'string' },
							arguments: { type: 'object', additionalProperties: true }
						},
						required: ['type'],
						additionalProperties: false
					}),
					'--system-prompt',
					system
				],
				prompt,
				{
					signal,
					cwd,
					decode: (output) => {
						const result = JSON.parse(output)
						if (result.type !== 'result' || result.is_error || result.subtype !== 'success')
							throw new Error(
								`Claude model/response failure: ${String(result.result ?? result.subtype).slice(0, 500)}`
							)
						if (result.structured_output === undefined)
							throw new Error('Claude returned no structured output')
						return JSON.stringify(result.structured_output)
					}
				}
			)
		} finally {
			await rm(cwd, { recursive: true, force: true })
		}
	}
}

async function probe(backend: AgentBackend, signal: AbortSignal) {
	let value: string | undefined
	let calls = 0
	const agent = new Agent({
		initialState: {
			model: backend.model,
			systemPrompt:
				'Call lookupFixture exactly once, then return its exact text as the final answer.',
			tools: [
				{
					name: 'lookupFixture',
					label: 'Read readiness fixture',
					description: 'Returns the value required for the readiness check.',
					parameters: Type.Object({}, { additionalProperties: false }),
					async execute() {
						signal.throwIfAborted()
						value = crypto.randomUUID()
						return { content: [{ type: 'text', text: value }], details: {} }
					}
				}
			]
		},
		streamFn: backend.streamFn,
		beforeToolCall: async () => {
			if (++calls > 1) {
				agent.abort()
				throw new Error('Readiness requested more than one tool call')
			}
		}
	})
	const abort = () => agent.abort()
	signal.addEventListener('abort', abort, { once: true })
	try {
		signal.throwIfAborted()
		await agent.prompt('Perform the readiness check.')
		signal.throwIfAborted()
		const last = agent.state.messages.at(-1)
		if (
			calls !== 1 ||
			!value ||
			last?.role !== 'assistant' ||
			last.stopReason !== 'stop' ||
			last.content.length !== 1 ||
			last.content[0]?.type !== 'text' ||
			last.content[0].text !== value
		)
			throw new Error(
				`model/response readiness failed: ${agent.state.errorMessage ?? 'expected exact fixture value'}`
			)
	} finally {
		await agent.waitForIdle()
		signal.removeEventListener('abort', abort)
	}
}
