import type { EmbeddingProvider } from './embedding'

type OpenAIEmbeddingResponse = {
	data: Array<{
		index: number
		embedding: number[]
	}>
}

type OpenAIErrorResponse = {
	error?: {
		message?: string
	}
}

const MODEL = 'text-embedding-3-small'
const DIMENSION = 512
const ENDPOINT = 'https://api.openai.com/v1/embeddings'

export function openAI(apiKey: string): EmbeddingProvider {
	return {
		provider: 'openai',
		model: MODEL,
		dims: DIMENSION,
		async embed(texts: string[]): Promise<number[][]> {
			if (texts.length === 0) return []
			if (!apiKey) {
				throw new Error('OpenAI API key is required for embeddings')
			}

			const response = await fetch(ENDPOINT, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${apiKey}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					input: texts,
					model: MODEL,
					dimensions: DIMENSION,
					encoding_format: 'float'
				})
			})

			if (!response.ok) {
				let message = 'Unable to read response body'
				try {
					const body = (await response.json()) as OpenAIErrorResponse
					message = body.error?.message ?? JSON.stringify(body)
				} catch {
					message = await response.text().catch(() => message)
				}
				throw new Error(`OpenAI embeddings request failed (${response.status}): ${message}`)
			}

			const payload = (await response.json()) as OpenAIEmbeddingResponse
			if (!Array.isArray(payload.data)) {
				throw new Error('OpenAI embeddings response is missing data array')
			}

			return payload.data.sort((a, b) => a.index - b.index).map((entry) => entry.embedding)
		}
	}
}
