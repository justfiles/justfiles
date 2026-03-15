import type { LLM } from './llm'

async function chatComplete(
	apiKey: string,
	messages: Array<{ role: string; content: string }>,
	jsonMode = false
): Promise<string> {
	const body: Record<string, unknown> = {
		model: 'gpt-4o-mini',
		temperature: 0.3,
		messages
	}
	if (jsonMode) body.response_format = { type: 'json_object' }

	const response = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body)
	})

	if (!response.ok) throw new Error(`OpenAI request failed (${response.status})`)

	const data = (await response.json()) as { choices: Array<{ message: { content: string } }> }
	return data.choices[0]?.message.content ?? ''
}

export function openAI(apiKey: string): LLM {
	return {
		async expand(query: string) {
			const content = await chatComplete(
				apiKey,
				[
					{
						role: 'user',
						content: `Generate alternative search queries for: "${query}"

Respond with JSON in this exact format:
{"semantic":["variant1","variant2","variant3"],"keywordSets":[["kw1","kw2","kw3"],["kw1","kw2","kw3"],["kw1","kw2","kw3"]]}`
					}
				],
				true
			)
			const parsed = JSON.parse(content) as { semantic: string[]; keywordSets: string[][] }
			return {
				semantic: (parsed.semantic ?? []).slice(0, 3),
				keywordSets: (parsed.keywordSets ?? []).slice(0, 3)
			}
		},

		async generateMetadata(content: string) {
			const text = content.slice(0, 2000)
			const result = await chatComplete(
				apiKey,
				[
					{
						role: 'user',
						content: `Generate metadata for this note:

${text}

Respond with JSON in this exact format:
{"title":"short descriptive title","tags":["tag1","tag2"],"category":"path/category"}

IMPORTANT: Write the title in the same language that the note is mostly written in.`
					}
				],
				true
			)
			const parsed = JSON.parse(result) as { title: string; tags: string[]; category: string }
			return {
				title: parsed.title ?? '',
				tags: Array.isArray(parsed.tags) ? parsed.tags : [],
				category: parsed.category ?? 'inbox'
			}
		}
	}
}
