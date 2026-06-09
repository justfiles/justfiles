import type { LLMText } from '@justfiles/agent'
import { CapabilityError, implementCapability } from '@justfiles/app/capabilities'
import { ai } from '@justfiles/app/capabilities/ai'

// Host-side `ai` capability — one unit over the LLM text service. The isolate's
// `input` is untrusted, so a missing/non-string prompt is rejected as
// INVALID_INPUT rather than reaching the model.
export const aiCapability = (text: LLMText) =>
	implementCapability(ai, {
		generateText: async (_ctx, { system, prompt }) => {
			if (typeof prompt !== 'string')
				throw new CapabilityError('CAPABILITY_INVALID_INPUT', 'ai', 'generateText')
			return { text: await text.gen(typeof system === 'string' ? system : '', prompt) }
		}
	})
