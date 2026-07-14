// The shared account-provider registry both hosts assemble. Provider CLIENT code
// (Gmail/Calendar fetch, iCloud CalDAV) and the provider shapes live here; the
// host-specific seams — OAuth acquisition (`signIn`), the ChatGPT `ai` mint + model
// catalogue, and the platform-AI text runtime — are injected per host. A provider
// is included only when its deps are supplied, so a host offers exactly the set it
// can serve.

import type { Provider, ProviderRegistry } from '../host.ts'
import { type ChatgptDeps, chatgptProvider } from './chatgpt.ts'
import { type GoogleProviderDeps, googleProvider } from './google.ts'
import { icloudProvider } from './icloud.ts'

export type { ChatgptDeps } from './chatgpt.ts'
export type { GoogleClient, GoogleCreds, GoogleProviderDeps, OAuthSignIn } from './google.ts'

export interface BuildProvidersDeps {
	chatgpt?: ChatgptDeps
	google?: GoogleProviderDeps
	// iCloud is a static form provider — no host seam, just opt in.
	icloud?: boolean
	// Platform AI ("Spud AI"): mint `ai` over a host-supplied generate fn. Kept as a
	// bare function so this package needs no @justfiles/agent dependency.
	spud?: { generate: (system: string, prompt: string) => Promise<string> }
}

export function buildProviders(deps: BuildProvidersDeps): ProviderRegistry {
	const list: Provider[] = []
	if (deps.chatgpt) list.push(chatgptProvider(deps.chatgpt))
	if (deps.google) list.push(googleProvider(deps.google))
	if (deps.icloud) list.push(icloudProvider())
	if (deps.spud) list.push(spudProvider(deps.spud.generate))
	return new Map(list.map((p) => [p.id, p]))
}

// The platform-provided AI: no user credentials — "connecting" just declares the
// account, and the `ai` facet is served by the host's own backend. The platform,
// not the user, owns the vendor/model, so there is no model picker (`describe`).
function spudProvider(generate: (system: string, prompt: string) => Promise<string>): Provider {
	return {
		id: 'spud',
		name: 'Spud AI',
		builtin: true,
		auth: { kind: 'form', credentialsSchema: { type: 'object', properties: {} } },
		mint: {
			ai: () => ({
				generateText: async ({ system, prompt }) => ({
					text: await generate(typeof system === 'string' ? system : '', prompt)
				})
			})
		}
	}
}
