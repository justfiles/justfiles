import { completeSimple } from '@mariozechner/pi-ai'
import type { LLMConfig } from './llm'
import { NOTE_TAKING_PROMPT } from './prompts'

export type LLMText = ReturnType<typeof text>

export function text({ model, apiKey }: LLMConfig) {
	return { gen, takeNotes, summarise }

	async function gen(systemPrompt: string, userPrompt: string) {
		const response = await completeSimple(
			model,
			{
				systemPrompt,
				messages: [
					{
						role: 'user',
						content: userPrompt,
						timestamp: Date.now()
					}
				]
			},
			{ apiKey }
		)

		return response.content
			.filter((block) => block.type === 'text')
			.map((block) => block.text)
			.join('')
			.trim()
	}

	async function takeNotes(content: string) {
		const notes = await gen(NOTE_TAKING_PROMPT, content)
		if (notes.trim() === '') return undefined
		return notes
	}

	async function summarise(content: string) {
		return await gen(NOTE_TAKING_PROMPT, content)
	}
}
