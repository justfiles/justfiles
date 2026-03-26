import type { LLM } from './llm'

async function chatComplete(
	apiKey: string,
	messages: Array<{ role: string; content: string }>,
	jsonMode = false,
	temperature = 0.3
): Promise<string> {
	const body: Record<string, unknown> = {
		model: 'gpt-4o-mini',
		temperature,
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
						content: `Generate search variants for: "${query}"

- lex: keyword-only form for BM25 full-text search — strip ALL stop words, keep only 3-6 meaningful content words
- semantic: array of 2-3 rephrased variants for embedding similarity search
- hyde: one short paragraph (2-4 sentences) that would directly contain the answer to this query — used for hypothetical document embedding

Respond with JSON in this exact format:
{"lex":"keyword1 keyword2 keyword3","semantic":["variant1","variant2"],"hyde":"A short paragraph that answers the query..."}`
					}
				],
				true,
				0
			)
			const parsed = JSON.parse(content) as { lex: string; semantic: string[]; hyde: string }
			return {
				lex: (parsed.lex ?? '').trim(),
				semantic: (parsed.semantic ?? []).slice(0, 3),
				hyde: (parsed.hyde ?? '').trim()
			}
		},

		async generateMetadata(content: string) {
			const text = content.slice(0, 2000)
			const result = await chatComplete(
				apiKey,
				[
					{
						role: 'system',
						content: 'You are a note metadata generator. Always write the title in the same language as the note content. Never translate the title into another language.'
					},
					{
						role: 'user',
						content: `Generate metadata for this note:

${text}

Respond with JSON in this exact format:
{"title":"short descriptive title","tags":["tag1","tag2"],"category":"path/category"}`
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
