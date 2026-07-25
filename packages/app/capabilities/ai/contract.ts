// The `ai` capability is a single USE facet any app may call. Setup (sign-in,
// model pick) is no longer a sibling `ai/admin` facet — it folded into the
// `accounts` model, where ChatGPT is just an oauth provider that backs `ai` and
// the selected model rides as that capability's per-account config. A host serves
// `generateText` over whatever backend the user connected (frieren over its LLM
// text service; quay over the resolved accounts provider).

// USE facet — exposed to every app via `@justfiles/app/capabilities/ai`.
export interface AiCapability {
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
