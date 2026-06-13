// The frieren provider registry: which providers exist, how each authenticates,
// and how each mints a use-facet impl from stored creds. A provider also declares
// the agent commands its capabilities register (kept working alongside the use
// facets until the agent calls capabilities directly — see ACCOUNTS-PLAN.md).
//
// Provider client code (JMAP, CalDAV) and the agent command builders are reused
// verbatim from `worker/integrations/*`; this module only re-expresses them in the
// accounts shape.

import type { Command } from '@justfiles/agent'
import type { CapabilityId, CredentialsSchema } from '@justfiles/app/capabilities/accounts'
import type { Creds, Provider, ProviderRegistry } from '@justfiles/app/capabilities/accounts/host'
import { createIcloudCalendarProvider } from '../capabilities/calendar/providers/icloud.ts'
import { createFastmailCommand } from '../integrations/fastmail/commands.ts'
import { createJmapClient } from '../integrations/fastmail/jmap.ts'
import { fastmailEmailProvider } from '../integrations/fastmail/provider.ts'
import { createCalDavClient } from '../integrations/icloud-calendar/caldav.ts'
import { createIcloudCalendarCommand } from '../integrations/icloud-calendar/commands.ts'

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

export type CommandFactory = (creds: Creds, accountId: string) => Command[]
export type CommandFactories = Map<string, Partial<Record<CapabilityId, CommandFactory>>>

export interface ProviderBundle {
	registry: ProviderRegistry
	commands: CommandFactories
}

export function buildProviders(opts: {
	getTimezone: () => Promise<string> | string
}): ProviderBundle {
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

	const registry: ProviderRegistry = new Map([
		[fastmail.id, fastmail],
		[icloud.id, icloud]
	])
	const commands: CommandFactories = new Map([
		[
			'fastmail',
			{
				email: (creds) => [
					createFastmailCommand(createJmapClient({ token: creds.token as string }))
				]
			}
		],
		[
			'icloud',
			{
				calendar: (creds) => [
					createIcloudCalendarCommand(
						createCalDavClient({
							username: creds.username as string,
							password: creds.password as string
						}),
						{ getTimezone: opts.getTimezone }
					)
				]
			}
		]
	])
	return { registry, commands }
}
