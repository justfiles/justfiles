// App-facing text generation and foreground delegation. Both use the host-selected backend.

export interface AiCapability {
	runAgent(input: {
		requestId: string
		prompt: string
	}): Promise<{ text: string } | { cancelled: true }>
	cancelAgent(input: { requestId: string }): Promise<boolean>

	generateText(input: {
		system?: string
		prompt: string
		// Opt into a host-owned, purpose-scoped context projection. The host reads
		// trusted user knowledge and prepends a prompt-safe fragment; the app never
		// sees the projection or the composed system prompt. `'learning'` requires the
		// `context:learning` scope. A typed union, never an arbitrary string — a new
		// value is added only alongside its own scope and privacy policy.
		context?: 'learning'
		temperature?: number
		maxTokens?: number
	}): Promise<{ text: string }>
}
