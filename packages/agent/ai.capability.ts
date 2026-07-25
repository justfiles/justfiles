// The host-side `ai` capability (issue #272). It owns everything context-related:
// the `context:learning` scope gate and the purpose-scoped learning projection
// (composed from the user's Volume via `learningContext`). Callers supply only
// LOW-LEVEL infra — a Volume plus a raw `generate` fn over their credentialed
// model — so `accounts` and providers stay unaware of context, and both hosts
// (frieren, spud) build the same capability the same way.
//
// A system prompt is not a security boundary against the model (see #272): a
// scope-bearing app can coax the model to echo the prepended fragment. That is
// an accepted, bounded risk because the fragment carries only disclosure-safe
// adaptation hints (a coarse age + the sanitized, PII-free learning projection).
// The guarantee is that the projection never crosses into the app AS DATA
// (params/state/the `{ text }` result), not echo-resistance.

import { CapabilityError, implementCapability } from '@justfiles/app/capabilities'
import { ai } from '@justfiles/app/capabilities/ai'
import type { Volume } from '@justfiles/fs'
import { learningContext } from './learning-context.ts'

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
export function aiCapability(deps: { generate: GenerateText; volume?: Volume }) {
	const { generate, volume } = deps
	const learning = volume
		? learningContext({ volume, gen: (system, prompt) => generate({ system, prompt }) }).compose
		: undefined

	return implementCapability(ai, {
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
