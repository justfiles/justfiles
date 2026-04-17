import { completeSimple } from '@mariozechner/pi-ai';
import type { LLMConfig } from './llm';

export type GenerateText = (
	systemPrompt: string,
	userPrompt: string,
) => Promise<string>

export function text({model, apiKey}: LLMConfig): GenerateText {
	return async (systemPrompt: string, userPrompt: string) => {
		const response = await completeSimple(model, {
			systemPrompt,
			messages: [
				{
					role: 'user',
					content: userPrompt,
					timestamp: Date.now(),
				},
			],
		}, { apiKey });

		return response.content
			.filter((block) => block.type === 'text')
			.map((block) => block.text)
			.join('')
			.trim()
	};
}
