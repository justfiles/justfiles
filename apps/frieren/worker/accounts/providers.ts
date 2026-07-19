// frieren's account providers. Google/iCloud/Spud are the shared modules — the
// Worker differs from the daemon only in constructor args:
//   - Spud AI binds `ai` over the host's own env-keyed LLM (the platform owns the
//     vendor/model), and
//   - interactive acquisition is refused clearly — those accounts are signed in on
//     the Spud desktop app and sync here (DESIGN §9) — until a web-redirect
//     AuthFlow lands. ChatGPT is a local marker so Settings lists it; its runtime
//     (pi-ai) lives only in the daemon.

import type { LLMText } from '@justfiles/agent'
import {
	type AuthFlow,
	googleProvider,
	icloudProvider,
	type Provider,
	spudProvider
} from '@justfiles/app/capabilities/accounts/providers'

export interface ProviderDeps {
	text: LLMText
}

const DESKTOP_MESSAGE = 'Sign in to this account from the Spud desktop app — it will sync here.'

// The Worker has no browser/loopback to run an interactive flow; refuse before the
// provider even builds its authorize URL.
const acquireOnDesktop: AuthFlow = {
	authorize: async () => {
		throw new Error(DESKTOP_MESSAGE)
	}
}

export function buildProviders(deps: ProviderDeps): Provider[] {
	return [
		googleProvider({ flow: acquireOnDesktop, client: null }),
		icloudProvider(),
		chatgptOnDesktop(),
		spudProvider({ generate: (system, prompt) => deps.text.gen(system, prompt) })
	]
}

function chatgptOnDesktop(): Provider {
	return {
		id: 'chatgpt',
		name: 'ChatGPT',
		auth: {
			ui: { kind: 'interactive' },
			acquire: async () => {
				throw new Error(DESKTOP_MESSAGE)
			}
		},
		capabilities: {
			ai: {
				bind: () => {
					throw new Error('ChatGPT is used from the Spud desktop app')
				}
			}
		}
	}
}
