// ChatGPT provider — the "Sign in with ChatGPT" subscription, backing `ai`. The
// host-specific parts are injected: acquisition (`signIn` — loopback in the daemon,
// device/redirect elsewhere), the `ai` mint over the token (built with the host's
// LLM runtime, so this package needs no @justfiles/agent), and the model catalogue.

import type { AiCapability } from '../../ai/index.ts'
import type { Creds, Provider } from '../host.ts'
import type { OAuthSignIn } from './google.ts'

export interface ChatgptDeps {
	// OAuth acquisition (host-specific).
	signIn: OAuthSignIn
	// Build the `ai` use facet over the stored token + selected model.
	mintAi: (creds: Creds, config: unknown) => AiCapability
	// The selectable models for the model picker, and the default selection.
	models: () => { id: string; name: string }[]
	defaultModel: () => string
}

export function chatgptProvider(deps: ChatgptDeps): Provider {
	return {
		id: 'chatgpt',
		name: 'ChatGPT',
		auth: { kind: 'oauth', signIn: deps.signIn },
		mint: { ai: (creds, config) => deps.mintAi(creds, config) },
		describe: {
			ai: (config) => ({
				model: (config as { model?: string } | undefined)?.model ?? deps.defaultModel(),
				models: deps.models()
			})
		}
	}
}
