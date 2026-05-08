import type { EmailCapability, EmailDetail, EmailSummary } from '@justfiles/app/capabilities/email'
import {
	createJmapClient,
	type EmailAddress,
	type JmapClient,
	type EmailDetails as JmapEmailDetails,
	type EmailSummary as JmapEmailSummary
} from './jmap.ts'

export const FASTMAIL_PROVIDER_ID = 'fastmail'

export interface FastmailEmailCredentials {
	token: string
}

export function formatFrom(addrs: readonly EmailAddress[] | undefined): string {
	const first = addrs?.[0]
	if (!first) return ''
	const name = first.name?.trim()
	return name ? `${name} <${first.email}>` : first.email
}

export function normalizeEmailSummary(input: JmapEmailSummary): EmailSummary {
	return {
		id: input.id,
		from: formatFrom(input.from),
		subject: input.subject ?? '',
		receivedAt: Date.parse(input.receivedAt),
		unread: true
	}
}

export function normalizeEmailDetail(input: JmapEmailDetails): EmailDetail {
	return {
		id: input.id,
		from: formatFrom(input.from),
		subject: input.subject ?? '',
		receivedAt: Date.parse(input.receivedAt),
		unread: false,
		bodyText: input.text
	}
}

export function buildFastmailEmailCapability(client: JmapClient): EmailCapability {
	return {
		async listUnread({ limit }) {
			const list = await client.list({ limit: limit ?? 20, unread: true })
			return list.map(normalizeEmailSummary)
		},
		async readDetail({ id }) {
			const detail = await client.read(id)
			return normalizeEmailDetail(detail)
		},
		async markRead({ id }) {
			await client.markRead(id)
			return { success: true }
		}
	}
}

interface FastmailEmailProviderOptions {
	clientFactory?: (creds: FastmailEmailCredentials) => JmapClient
}

export function createFastmailEmailProvider(opts: FastmailEmailProviderOptions = {}) {
	const factory = opts.clientFactory ?? ((creds) => createJmapClient({ token: creds.token }))
	return {
		id: FASTMAIL_PROVIDER_ID,
		name: 'Fastmail',
		description: 'Fastmail email via JMAP',
		create(credentials: unknown): EmailCapability {
			const creds = credentials as FastmailEmailCredentials | null | undefined
			if (!creds || typeof creds.token !== 'string' || creds.token.length === 0) {
				throw new Error('fastmail email provider: missing or invalid token')
			}
			return buildFastmailEmailCapability(factory(creds))
		}
	}
}

export const fastmailEmailProvider = createFastmailEmailProvider()
