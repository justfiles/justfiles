// frieren's account host seams. The client code (Gmail, CalDAV) and the provider
// catalog are shared with spud-mac (@justfiles/app); frieren only supplies the parts
// that differ on the Worker:
//   - Spud AI mints `ai` over the host's own env-keyed LLM (the platform owns the
//     vendor/model), and
//   - OAuth providers (Google, ChatGPT) are *acquired on the Spud desktop app* and
//     sync here (DESIGN §9) — the Worker has no browser/loopback to run the flow, so
//     connecting them from the browser is refused clearly until the web-redirect flow
//     lands.

import type { LLMText } from '@justfiles/agent'
import type { AccountsDeps } from '@justfiles/app/capabilities/accounts/host'
import type { OAuthSignIn } from '@justfiles/app/capabilities/accounts/providers'

export interface ProviderDeps {
	text: LLMText
}

const acquireOnDesktop: OAuthSignIn = async () => {
	throw new Error('Sign in to this account from the Spud desktop app — it will sync here.')
}

// The Worker's `AccountsDeps` (passed straight to `accountsCapabilities`).
export function buildProviders(deps: ProviderDeps): AccountsDeps {
	return {
		chatgpt: {
			signIn: acquireOnDesktop,
			mintAi: () => {
				throw new Error('ChatGPT is used from the Spud desktop app')
			},
			models: () => [],
			defaultModel: () => ''
		},
		google: { signIn: acquireOnDesktop, refreshClient: null },
		icloud: true,
		spud: { generate: (system, prompt) => deps.text.gen(system, prompt) }
	}
}
