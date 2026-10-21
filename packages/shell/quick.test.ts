import {
	createModels,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider
} from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { createQuick } from './quick.ts'

describe('createQuick', () => {
	const faux = fauxProvider({
		models: [
			{ id: 'faux-1', reasoning: true },
			{ id: 'faux-2', reasoning: true }
		]
	})
	const models = createModels()
	models.setProvider(faux.provider)
	const quick = createQuick(models, 'faux', 'faux-1')
	const seen: Parameters<FauxResponseFactory>[] = []
	const record: FauxResponseFactory = (...args) => {
		seen.push(args)
		return fauxAssistantMessage('  An apple a day.\n')
	}

	it('sends the system prompt and text to the default model, and trims the answer', async () => {
		faux.setResponses([record])
		const answer = await quick(
			{ type: 'quick', text: 'apple', system: 'Explain.' },
			new AbortController().signal
		)
		expect(answer).toBe('An apple a day.')
		const [context, options, , model] = seen.at(-1)!
		expect(model.id).toBe('faux-1')
		expect(context.messages.map((message) => message.role)).toEqual(['system', 'user'])
		expect(context.messages[0]).toMatchObject({ content: 'Explain.' })
		expect(context.messages[1]).toMatchObject({ content: 'apple' })
		expect(options?.reasoning).toBeUndefined()
	})

	it('takes the model and effort the request names', async () => {
		faux.setResponses([record])
		await quick(
			{ type: 'quick', text: 'apple', model: 'faux-2', effort: 'low' },
			new AbortController().signal
		)
		const [context, options, , model] = seen.at(-1)!
		expect(model.id).toBe('faux-2')
		expect(context.messages.map((message) => message.role)).toEqual(['user'])
		expect(options?.reasoning).toBe('low')
	})

	it('refuses a model the provider does not have, and reports a model error', async () => {
		const signal = new AbortController().signal
		await expect(quick({ type: 'quick', text: 'x', model: 'nope' }, signal)).rejects.toThrow(
			'faux has no model nope'
		)
		faux.setResponses([
			fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'rate limited' })
		])
		await expect(quick({ type: 'quick', text: 'x' }, signal)).rejects.toThrow('rate limited')
	})
})
