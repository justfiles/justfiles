// The frieren provider registry: which providers exist, how each authenticates,
// and how each mints a use-facet impl from stored creds. The agent and apps reach
// email/calendar/ai only through those minted capabilities — the creds never leave
// the provider.
//
// Provider client code (CalDAV) is reused from `worker/integrations/*`; this module
// only re-expresses it in the accounts shape.

import type { LLMText } from '@justfiles/agent'
import type { CredentialsSchema } from '@justfiles/app/capabilities/accounts'
import type { Provider, ProviderRegistry } from '@justfiles/app/capabilities/accounts/host'
import { createIcloudCalendarProvider } from '../capabilities/calendar/providers/icloud.ts'

const icloudSchema: CredentialsSchema = {
	type: 'object',
	properties: {
		username: {
			type: 'string',
			minLength: 1,
			description: 'Apple ID email address used to sign into iCloud.'
		},
		password: {
			type: 'string',
			minLength: 1,
			description:
				'App-specific password generated at appleid.apple.com → Sign-In and Security → App-Specific Passwords. Not your Apple ID password.'
		}
	},
	required: ['username', 'password']
}

// Providers need host-supplied runtime seams: Spud AI mints its `ai` facet over the
// host's own LLM text service (the same env-keyed backend the agent runs on), so the
// platform — not the user — owns the vendor/model choice.
export interface ProviderDeps {
	text: LLMText
}

export function buildProviders(deps: ProviderDeps): ProviderRegistry {
	const icloudCalendar = createIcloudCalendarProvider()

	// The platform-provided AI: no user credentials — "connecting" just declares the
	// account, and the `ai` facet is served by the host's own backend (spud.computer's
	// OpenAI key today). The alternative is a personal ChatGPT provider (later); the
	// user picks one by enabling its `ai` capability.
	const spud: Provider = {
		id: 'spud',
		name: 'Spud AI',
		auth: { kind: 'form', credentialsSchema: { type: 'object', properties: {} } },
		mint: {
			ai: () => ({
				generateText: async ({ system, prompt }) => ({
					text: await deps.text.gen(typeof system === 'string' ? system : '', prompt)
				})
			})
		}
	}
	const icloud: Provider = {
		id: 'icloud',
		name: 'iCloud',
		auth: { kind: 'form', credentialsSchema: icloudSchema },
		mint: { calendar: (creds) => icloudCalendar.create(creds) }
	}

	return new Map([
		[spud.id, spud],
		[icloud.id, icloud]
	])
}
