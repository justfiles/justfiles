import { contentText, type Models } from '@earendil-works/pi-ai'
import type { Request } from './protocol.ts'

/** One completion for a `quick` request: the answer's text. Throws on a model error. */
export type Quick = (
	request: Extract<Request, { type: 'quick' }>,
	signal: AbortSignal
) => Promise<string>

/**
 * Quick completions on `models`, each with the model the request names on `provider`, or
 * `modelId` without one. The request's `system` is the system prompt and its `text` the one
 * user message; nothing of the conversation goes along.
 */
export function createQuick(models: Models, provider: string, modelId: string): Quick {
	return async ({ text, system, model: id = modelId, effort }, signal) => {
		const model = models.getModel(provider, id)
		if (model === undefined) throw new Error(`${provider} has no model ${id}`)
		const answer = await models.completeSimple(
			model,
			{
				...(system === undefined ? {} : { systemPrompt: system }),
				messages: [{ role: 'user', content: text, timestamp: Date.now() }]
			},
			{ signal, ...(effort === undefined ? {} : { reasoning: effort }) }
		)
		if (answer.stopReason === 'error' || answer.stopReason === 'aborted')
			throw new Error(answer.errorMessage ?? `the model stopped: ${answer.stopReason}`)
		return contentText(answer.content).trim()
	}
}
