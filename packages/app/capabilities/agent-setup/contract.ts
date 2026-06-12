// App-facing capability for configuring the AI agent's backend. Lets the
// Settings app sign the user in to a model provider and pick a model. The host
// owns the OAuth flow and credential storage (a file on the Volume); this
// contract is the smallest surface the Settings UI needs.
//
// v1 has exactly one provider — "Sign in with ChatGPT" (the user's existing
// ChatGPT subscription, via OpenAI's Codex OAuth) — so the surface is provider-
// agnostic but the only `signIn` provider is `chatgpt`.

export interface AgentModelOption {
	id: string
	name: string
}

export interface AgentStatus {
	connected: boolean
	// The ChatGPT account id (from the OAuth id_token), shown when connected.
	account?: string
	// The currently selected model id.
	model?: string
	// Models the connected account may use. Empty until connected.
	models: AgentModelOption[]
}

export interface AgentSetupCapability {
	status(input: Record<string, never>): Promise<AgentStatus>
	// Run the host-side OAuth flow (opens the browser, catches the redirect).
	// Resolves once the credential is stored; the UI then re-reads `status`.
	signIn(input: { provider: 'chatgpt' }): Promise<void>
	selectModel(input: { model: string }): Promise<void>
	signOut(input: Record<string, never>): Promise<void>
}
