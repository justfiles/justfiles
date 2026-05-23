import type { EmailCapability } from '@justfiles/app/capabilities/email'
import {
	createJmapClient,
	type EmailAddress,
	type JmapClient,
	type EmailDetails as JmapEmailDetails,
	type EmailSummary as JmapEmailSummary
} from './jmap.ts'

const PROVIDER_ID = 'fastmail'

function formatFrom(addrs: readonly EmailAddress[] | undefined): string {
	const first = addrs?.[0]
	if (!first) return ''
	const name = first.name?.trim()
	return name ? `${name} <${first.email}>` : first.email
}

function normalizeSummary(input: JmapEmailSummary) {
	return {
		id: input.id,
		from: formatFrom(input.from),
		subject: input.subject ?? '',
		receivedAt: Date.parse(input.receivedAt),
		unread: true
	}
}

function normalizeDetail(input: JmapEmailDetails) {
	return {
		id: input.id,
		from: formatFrom(input.from),
		subject: input.subject ?? '',
		receivedAt: Date.parse(input.receivedAt),
		unread: false,
		bodyText: input.text
	}
}

function buildCapability(client: JmapClient): EmailCapability {
	return {
		async listUnread({ limit }) {
			const list = await client.list({ limit: limit ?? 20, unread: true })
			return list.map(normalizeSummary)
		},
		async readDetail({ id }) {
			const detail = await client.read(id)
			return normalizeDetail(detail)
		},
		async markRead({ id }) {
			await client.markRead(id)
			return { success: true }
		}
	}
}

interface FastmailEmailProviderOptions {
	clientFactory?: (creds: { token: string }) => JmapClient
}

export function createFastmailEmailProvider(opts: FastmailEmailProviderOptions = {}) {
	const factory = opts.clientFactory ?? ((creds) => createJmapClient({ token: creds.token }))
	return {
		id: PROVIDER_ID,
		name: 'Fastmail',
		description: 'Fastmail email via JMAP',
		create(credentials: unknown): EmailCapability {
			const token = (credentials as { token?: unknown } | null | undefined)?.token
			if (typeof token !== 'string' || token.length === 0) {
				throw new Error('fastmail email provider: missing or invalid token')
			}
			return buildCapability(factory({ token }))
		}
	}
}

export const fastmailEmailProvider = createFastmailEmailProvider()
