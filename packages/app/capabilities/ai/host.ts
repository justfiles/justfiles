import { CapabilityError, implementCapability } from '../index.ts'
import type { AgentBackend } from './agent/backend.ts'
import type { Fetch } from './agent/fetch.ts'
import { runAgent } from './agent/run.ts'
import { ai } from './index.ts'

// The raw text backend the capability generates over. `system` is the FINAL,
// host-composed system prompt; the fn never sees the `context` selector.
export type GenerateText = (input: {
	system: string
	prompt: string
	temperature?: number
	maxTokens?: number
}) => Promise<string>

export function aiCapability(deps: {
	generate: GenerateText
	learning?(): Promise<string>
	agent?: {
		backend(signal: AbortSignal): Promise<AgentBackend | null>
		fetch: Fetch
		drain?(signal: AbortSignal): Promise<void>
		keepAlive?(work: Promise<unknown>): void
	}
}) {
	const { generate, learning } = deps
	const active = new Map<
		string,
		{ requestId: string; stop: AbortController; work?: Promise<unknown> }
	>()
	let closed = false

	const capability = implementCapability(ai, {
		runAgent: (ctx, input) => {
			if (!ctx.scopes.includes('agent'))
				throw new CapabilityError('CAPABILITY_DENIED', 'ai', 'runAgent')
			if (
				!input ||
				typeof input.requestId !== 'string' ||
				!input.requestId.trim() ||
				typeof input.prompt !== 'string' ||
				!input.prompt.trim()
			)
				throw new CapabilityError('CAPABILITY_INVALID_INPUT', 'ai', 'runAgent')
			const agent = deps.agent
			const app = ctx.app
			if (closed || !agent || !app)
				throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'ai', 'runAgent')
			if (active.has(ctx.appId)) throw new CapabilityError('CAPABILITY_FAILED', 'ai', 'runAgent')
			const stop = new AbortController()
			const entry: { requestId: string; stop: AbortController; work?: Promise<unknown> } = {
				requestId: input.requestId,
				stop
			}
			active.set(ctx.appId, entry)
			const timer = setTimeout(() => stop.abort(new Error('Agent exceeded ten minutes')), 600_000)
			let onAbort!: () => void
			const aborted = new Promise<never>((_, reject) => {
				onAbort = () => reject(stop.signal.reason)
				stop.signal.addEventListener('abort', onAbort, { once: true })
			})
			const work = (async () => {
				try {
					stop.signal.throwIfAborted()
					// Account lookup may ignore abort; its late result must not start a task.
					const backend = await Promise.race([
						Promise.resolve().then(() => agent.backend(stop.signal)),
						aborted
					])
					stop.signal.throwIfAborted()
					if (!backend) throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'ai', 'runAgent')
					const text = await runAgent({
						prompt: input.prompt,
						backend,
						app,
						signal: stop.signal,
						fetch: agent.fetch
					})
					stop.signal.throwIfAborted()
					return { text }
				} catch (error) {
					await agent.drain?.(stop.signal)
					if (stop.signal.reason === 'cancelled') return { cancelled: true as const }
					if (error instanceof CapabilityError) throw error
					const failure = new CapabilityError('CAPABILITY_FAILED', 'ai', 'runAgent')
					failure.message = String(error instanceof Error ? error.message : error).slice(0, 2000)
					throw failure
				} finally {
					stop.signal.removeEventListener('abort', onAbort)
					clearTimeout(timer)
					active.delete(ctx.appId)
				}
			})()
			entry.work = work
			agent.keepAlive?.(work.catch(() => {}))
			return work
		},
		cancelAgent: (ctx, input) => {
			if (!ctx.scopes.includes('agent'))
				throw new CapabilityError('CAPABILITY_DENIED', 'ai', 'cancelAgent')
			if (!input || typeof input.requestId !== 'string' || !input.requestId.trim())
				throw new CapabilityError('CAPABILITY_INVALID_INPUT', 'ai', 'cancelAgent')
			if (!deps.agent) throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'ai', 'cancelAgent')
			const entry = active.get(ctx.appId)
			if (!entry || entry.requestId !== input.requestId) return false
			if (!entry.stop.signal.aborted) entry.stop.abort('cancelled')
			return entry.stop.signal.reason === 'cancelled'
		},
		generateText: async (ctx, input) => {
			if (!input || typeof input.prompt !== 'string')
				throw new CapabilityError('CAPABILITY_INVALID_INPUT', 'ai', 'generateText')
			let system = typeof input.system === 'string' ? input.system : ''
			if (input.context !== undefined) {
				// A typed union, never an open string: only `'learning'` is known.
				if (input.context !== 'learning')
					throw new CapabilityError('CAPABILITY_INVALID_INPUT', 'ai', 'generateText')
				if (!ctx.scopes.includes('context:learning'))
					throw new CapabilityError('CAPABILITY_DENIED', 'ai', 'generateText')
				const fragment = learning ? await learning() : ''
				if (fragment) system = `${fragment}\n\n${system}`
			}
			return {
				text: await generate({
					system,
					prompt: input.prompt,
					temperature: input.temperature,
					maxTokens: input.maxTokens
				})
			}
		}
	})
	return Object.assign(capability, {
		resume() {
			closed = false
		},
		async dispose() {
			closed = true
			for (const { stop } of active.values()) stop.abort('cancelled')
			await Promise.allSettled([...active.values()].map(({ work }) => work))
		}
	})
}

export type { AgentBackend, CompleteFn } from './agent/backend.ts'
export { createFetchTool, type Fetch } from './agent/fetch.ts'
export { createSearchTool } from './agent/search.ts'
