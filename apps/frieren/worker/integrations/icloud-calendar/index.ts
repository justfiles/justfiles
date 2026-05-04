import Type from 'typebox'
import type { Integration } from '../registry.ts'
import { createCalDavClient } from './caldav.ts'
import { createIcloudCalendarCommand } from './commands.ts'

export const icloudCalendarCredentialsSchema = Type.Object({
	username: Type.String({
		minLength: 1,
		description: 'Apple ID email address used to sign into iCloud.'
	}),
	password: Type.String({
		minLength: 1,
		description:
			'App-specific password generated at appleid.apple.com → Sign-In and Security → App-Specific Passwords. Not your Apple ID password.'
	})
})

export function icloudCalendarIntegration(): Integration {
	return {
		id: 'icloud-calendar',
		name: 'iCloud Calendar',
		description: 'List, read, create, and delete iCloud Calendar events via CalDAV',
		credentialsSchema: icloudCalendarCredentialsSchema,
		commands: (creds) => {
			const { username, password } = creds as { username: string; password: string }
			const client = createCalDavClient({ username, password })
			return [createIcloudCalendarCommand(client)]
		}
	}
}
