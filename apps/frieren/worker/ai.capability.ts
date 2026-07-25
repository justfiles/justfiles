import { type LLMText, learningContext } from '@justfiles/agent'
import { CapabilityError, implementCapability } from '@justfiles/app/capabilities'
import { ai } from '@justfiles/app/capabilities/ai'
import { type ContextComposers, composeSystem } from '@justfiles/app/capabilities/ai/host'
import type { Volume } from '@justfiles/fs'

// Host-side `ai` capability — one unit over the LLM text service. The isolate's
// `input` is untrusted, so a missing/non-string prompt is rejected as
// INVALID_INPUT rather than reaching the model. When a `volume` is supplied, a
// scoped `context: 'learning'` request has the host-composed learning fragment
// prepended to the app system prompt (see `composeSystem`); raw profile/memory
// never reach the app.
export const aiCapability = (text: LLMText, volume?: Volume) => {
	const composers: ContextComposers | undefined = volume
		? { learning: learningContext({ volume, resolveText: async () => text }).compose }
		: undefined
	return implementCapability(ai, {
		generateText: async (ctx, { system, prompt, context }) => {
			if (typeof prompt !== 'string')
				throw new CapabilityError('CAPABILITY_INVALID_INPUT', 'ai', 'generateText')
			const composed = await composeSystem(ctx, { system, context }, composers)
			return { text: await text.gen(composed, prompt) }
		}
	})
}
