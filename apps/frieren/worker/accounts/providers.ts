// frieren's provider set, assembled from the shared registry
// (`@justfiles/app/capabilities/accounts/providers`). The client code (Gmail,
// CalDAV) and provider shapes are shared with spud-mac; frieren only supplies its
// host seams:
//   - Spud AI mints `ai` over the host's own env-keyed LLM (the platform owns the
//     vendor/model), and
//   - OAuth providers (Google, ChatGPT) are *acquired on the Spud desktop app* and
//     sync here (DESIGN §9) — the Worker has no browser/loopback to run the flow, so
//     connecting them from the browser is refused clearly until the web-redirect
//     flow lands.

import type { LLMText } from '@justfiles/agent'
import type { ProviderRegistry } from '@justfiles/app/capabilities/accounts/host'
import {
	buildProviders as buildShared,
	type OAuthSignIn
} from '@justfiles/app/capabilities/accounts/providers'

export interface ProviderDeps {
	text: LLMText
}

const acquireOnDesktop: OAuthSignIn = async () => {
	throw new Error('Sign in to this account from the Spud desktop app — it will sync here.')
}

export function buildProviders(deps: ProviderDeps): ProviderRegistry {
	return buildShared({
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
	})
}
