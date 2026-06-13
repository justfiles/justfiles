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
		temperature?: number
		maxTokens?: number
	}): Promise<{ text: string }>
}
