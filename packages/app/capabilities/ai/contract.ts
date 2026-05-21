export interface AiCapability {
	generateText(input: {
		system?: string
		prompt: string
		temperature?: number
		maxTokens?: number
	}): Promise<{ text: string }>
}
