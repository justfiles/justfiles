import type { LLMText } from '@justfiles/agent'
import {
	type AuthFlow,
	googleProvider,
	icloudProvider,
	type Provider,
	platformProvider
} from '@justfiles/app/capabilities/accounts/providers'
import type { GeneratedImage } from '@justfiles/app/capabilities/image'

export interface ProviderDeps {
	text: LLMText
	chatgpt?: Provider
	generateImage?: (prompt: string) => Promise<GeneratedImage[]>
}

const DESKTOP_MESSAGE = 'Connect this account on Just Computer for Mac.'

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
		...(deps.chatgpt ? [deps.chatgpt] : []),
		platformProvider({
			generate: (system, prompt) => deps.text.gen(system, prompt),
			generateImage: deps.generateImage
		})
	]
}
