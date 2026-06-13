// Gmail REST client behind the `email` use facet. listUnread fans the unread
// query into per-message metadata fetches; readDetail pulls the full payload and
// extracts the plain-text body; markRead drops the UNREAD label. The fan-out host
// stamps each summary with its accountId, so nothing here knows which account it
// is — it just talks to "me".

import type { EmailCapability, EmailDetail, EmailSummary } from '@justfiles/app/capabilities/email'
import type { AuthedFetch } from './oauth.ts'

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

export function createGmailEmail(fetch: AuthedFetch): EmailCapability {
	return {
		async listUnread({ limit }) {
			const res = await fetch(`${BASE}/messages?q=is:unread&maxResults=${limit ?? 20}`)
			const { messages = [] } = (await res.json()) as { messages?: { id: string }[] }
			return Promise.all(messages.map(async (m) => summarize(await get(fetch, m.id, 'metadata'))))
		},
		async readDetail({ id }) {
			return detail(await get(fetch, id, 'full'))
		},
		async markRead({ id }) {
			await fetch(`${BASE}/messages/${id}/modify`, {
				method: 'POST',
				body: JSON.stringify({ removeLabelIds: ['UNREAD'] })
			})
			return { success: true }
		}
	}
}

interface GmailPart {
	mimeType?: string
	headers?: { name: string; value: string }[]
	body?: { data?: string }
	parts?: GmailPart[]
}

interface GmailMessage {
	id: string
	internalDate?: string
	labelIds?: string[]
	payload?: GmailPart
}

async function get(
	fetch: AuthedFetch,
	id: string,
	format: 'metadata' | 'full'
): Promise<GmailMessage> {
	const q =
		format === 'metadata'
			? '?format=metadata&metadataHeaders=From&metadataHeaders=Subject'
			: '?format=full'
	return (await (await fetch(`${BASE}/messages/${id}${q}`)).json()) as GmailMessage
}

function header(msg: GmailMessage, name: string): string {
	return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

function summarize(msg: GmailMessage): EmailSummary {
	return {
		id: msg.id,
		from: header(msg, 'From'),
		subject: header(msg, 'Subject'),
		receivedAt: Number(msg.internalDate ?? 0),
		unread: msg.labelIds?.includes('UNREAD') ?? true
	}
}

function detail(msg: GmailMessage): EmailDetail {
	return { ...summarize(msg), bodyText: bodyText(msg.payload) }
}

// Prefer a text/plain part anywhere in the tree; else fall back to the top-level
// body (a single-part text/html mail). Searching plain-first stops a sibling HTML
// part from shadowing the plain alternative.
function bodyText(part: GmailPart | undefined): string {
	const plain = plainText(part)
	if (plain !== undefined) return plain
	return part?.body?.data ? decode(part.body.data) : ''
}

function plainText(part: GmailPart | undefined): string | undefined {
	if (!part) return undefined
	if (part.mimeType === 'text/plain' && part.body?.data) return decode(part.body.data)
	for (const child of part.parts ?? []) {
		const text = plainText(child)
		if (text !== undefined) return text
	}
	return undefined
}

const decode = (data: string): string => Buffer.from(data, 'base64url').toString('utf8')
