export interface QueryExpander {
	expand(query: string): Promise<string[]>
}

export function openAIExpander(apiKey: string): QueryExpander {
	return {
		async expand(query: string): Promise<string[]> {
			const response = await fetch('https://api.openai.com/v1/chat/completions', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${apiKey}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					model: 'gpt-4o-mini',
					temperature: 0.3,
					messages: [
						{
							role: 'user',
							content: `Generate 2 alternative search query phrasings for: "${query}"\nReturn only the queries, one per line, no numbering or explanation.`
						}
					]
				})
			})

			if (!response.ok) throw new Error(`OpenAI chat request failed (${response.status})`)

			const body = (await response.json()) as {
				choices: Array<{ message: { content: string } }>
			}
			return (body.choices[0]?.message.content ?? '')
				.split('\n')
				.map((l) => l.trim())
				.filter(Boolean)
				.slice(0, 2)
		}
	}
}
