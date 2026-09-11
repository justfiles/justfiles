// The host-side `ai` capability (issue #272). It owns everything context-related:
// the `context:learning` scope gate and the purpose-scoped learning projection
// (composed from the user's Volume via `learningContext`). Callers supply only
// LOW-LEVEL infra — a Volume plus a raw `generate` fn over their credentialed
// model — so `accounts` and providers stay unaware of context, and both hosts
// (frieren, the Mac app) build the same capability the same way.
//
// A system prompt is not a security boundary against the model (see #272): a
// scope-bearing app can coax the model to echo the prepended fragment. That is
// an accepted, bounded risk because the fragment carries only disclosure-safe
// adaptation hints — a coarse age plus short topic labels that `learningContext`
// filters DETERMINISTICALLY (rejecting instructions, structured identifiers, and
// free-form text before caching/composing), not merely via the model prompt. The
// guarantee is that the projection never crosses into the app AS DATA
// (params/state/the `{ text }` result), not echo-resistance.

import { CapabilityError, implementCapability } from '@justfiles/app/capabilities'
import { ai } from '@justfiles/app/capabilities/ai'
import type { Volume } from '@justfiles/fs'
import { learningContext } from './learning-context.ts'
import type { AgentBackend } from './llm.ts'
import { runAgent } from './run-agent.ts'
import type { Fetch } from './tools/fetch.ts'

// The raw text backend the capability generates over. `system` is the FINAL,
// host-composed system prompt; the fn never sees the `context` selector.
export type GenerateText = (input: {
	system: string
	prompt: string
	temperature?: number
	maxTokens?: number
}) => Promise<string>

// Build the `ai` capability. With a `volume`, a scoped `context: 'learning'`
// request has the host-composed learning fragment prepended to the app system
// prompt; without one, or for context-free calls, generation is a plain
// pass-through.
export function aiCapability(deps: {
	generate: GenerateText
	volume?: Volume
	agent?: {
		backend(signal: AbortSignal): Promise<AgentBackend | null>
		fetch: Fetch
		keepAlive?(work: Promise<unknown>): void
	}
}) {
	const { generate, volume } = deps
	const active = new Map<string, { requestId: string; stop: AbortController }>()
	const learning = volume
		? learningContext({ volume, gen: (system, prompt) => generate({ system, prompt }) }).compose
		: undefined

	return implementCapability(ai, {
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
			if (!agent || !app) throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'ai', 'runAgent')
			if (active.has(ctx.appId)) throw new CapabilityError('CAPABILITY_FAILED', 'ai', 'runAgent')
			const stop = new AbortController()
			active.set(ctx.appId, { requestId: input.requestId, stop })
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
					const backend = await Promise.race([agent.backend(stop.signal), aborted])
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
					if (stop.signal.reason === 'cancelled') return { cancelled: true as const }
					if (error instanceof CapabilityError) throw error
					throw new CapabilityError('CAPABILITY_FAILED', 'ai', 'runAgent')
				} finally {
					stop.signal.removeEventListener('abort', onAbort)
					clearTimeout(timer)
					active.delete(ctx.appId)
				}
			})()
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
			if (typeof input.prompt !== 'string')
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
}
