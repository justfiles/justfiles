import Type from 'typebox'
import type { Integration } from '../registry.ts'
import { createFastmailCommand } from './commands.ts'
import { createJmapClient } from './jmap.ts'

export const fastmailCredentialsSchema = Type.Object({ token: Type.String({ minLength: 1 }) })

export function fastmailIntegration(): Integration {
	return {
		id: 'fastmail',
		name: 'Fastmail',
		description: 'List, read, and send email via Fastmail JMAP',
		credentialsSchema: fastmailCredentialsSchema,
		commands: (creds) => {
			const { token } = creds as { token: string }
			const client = createJmapClient({ token })
			return [createFastmailCommand(client)]
		}
	}
}
