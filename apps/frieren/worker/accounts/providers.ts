// The frieren provider registry: which providers exist, how each authenticates,
// and how each mints a use-facet impl from stored creds. The agent and apps reach
// email/calendar only through those minted capabilities — the creds never leave the
// provider.
//
// Provider client code (JMAP, CalDAV) is reused verbatim from
// `worker/integrations/*`; this module only re-expresses it in the accounts shape.

import type { CredentialsSchema } from '@justfiles/app/capabilities/accounts'
import type { Provider, ProviderRegistry } from '@justfiles/app/capabilities/accounts/host'
import { createIcloudCalendarProvider } from '../capabilities/calendar/providers/icloud.ts'
import { fastmailEmailProvider } from '../integrations/fastmail/provider.ts'

// Plain credential forms for the Settings connect UI (descriptions preserved from
// the old typebox integration schemas).
const fastmailSchema: CredentialsSchema = {
	type: 'object',
	properties: {
		token: {
			type: 'string',
			minLength: 1,
			description:
				'Fastmail API token (Settings → Privacy & Security → API tokens). Not an app password.'
		}
	},
	required: ['token']
}

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

export function buildProviders(): ProviderRegistry {
	const icloudCalendar = createIcloudCalendarProvider()

	const fastmail: Provider = {
		id: 'fastmail',
		name: 'Fastmail',
		auth: { kind: 'form', credentialsSchema: fastmailSchema },
		mint: { email: (creds) => fastmailEmailProvider.create(creds) }
	}
	const icloud: Provider = {
		id: 'icloud',
		name: 'iCloud',
		auth: { kind: 'form', credentialsSchema: icloudSchema },
		mint: { calendar: (creds) => icloudCalendar.create(creds) }
	}

	return new Map([
		[fastmail.id, fastmail],
		[icloud.id, icloud]
	])
}
