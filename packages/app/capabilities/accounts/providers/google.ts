// Google provider for the accounts model — the fetch-based half that is portable
// across hosts (Cloudflare Worker and the native daemon): token exchange/refresh,
// a bearer-attaching `authedFetch`, and the Gmail/Calendar use-facet clients. The
// host-specific half — acquiring the token (loopback in the daemon, a web redirect
// in the Worker) — is injected as `signIn`; only the CLIENT credentials for refresh
// are injected as `refreshClient` (a Desktop client's "secret" isn't confidential,
// but Google still wants it on the token call).

import type { CalendarCapability, CalendarEvent } from '../../calendar/index.ts'
import type { EmailCapability, EmailDetail, EmailSummary } from '../../email/index.ts'
import type { Creds, Provider } from '../host.ts'

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

// The OAuth client credentials the token endpoint requires. Null → skip refresh
// (a near-expiry token is used as-is; a resulting 401 surfaces as re-auth).
export interface GoogleClient {
	id: string
	secret: string
}

// What an account from this provider stores. `expires` is epoch ms.
export interface GoogleCreds extends Creds {
	access: string
	refresh: string
	expires: number
	accountId: string
}

interface TokenResponse {
	access_token: string
	refresh_token?: string
	expires_in: number
	id_token?: string
	scope?: string
}

// Exchange authorization/refresh params for tokens (a plain POST, no browser). The
// daemon's loopback `signIn` and the Worker's redirect callback both call this.
export async function googleExchange(
	client: GoogleClient,
	params: Record<string, string>
): Promise<TokenResponse> {
	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: client.id,
			client_secret: client.secret,
			...params
		}).toString()
	})
	if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`)
	return (await res.json()) as TokenResponse
}

// Google omits `refresh_token` on refresh, so the old one carries.
export async function googleRefresh(
	creds: GoogleCreds,
	client: GoogleClient
): Promise<GoogleCreds> {
	const token = await googleExchange(client, {
		grant_type: 'refresh_token',
		refresh_token: creds.refresh
	})
	return {
		access: token.access_token,
		refresh: token.refresh_token ?? creds.refresh,
		expires: Date.now() + token.expires_in * 1000,
		accountId: creds.accountId
	}
}

export type AuthedFetch = (
	path: string,
	init?: { method?: string; body?: string }
) => Promise<Response>

// A bearer-attaching fetch over an account's creds, refreshing once on near expiry
// when a `refreshClient` is available. Mint has no store, so the rotated token isn't
// persisted — the next call refreshes again; a failed/absent refresh falls through
// to a 401 that surfaces as re-auth.
export function authedFetch(creds: GoogleCreds, refreshClient: GoogleClient | null): AuthedFetch {
	let access = creds.access
	let refreshed = false
	return async (path, init = {}) => {
		if (!refreshed && refreshClient && creds.refresh && creds.expires - Date.now() < 60_000) {
			refreshed = true
			try {
				access = (await googleRefresh(creds, refreshClient)).access
			} catch {
				// keep the stale token; the request below 401s into re-auth
			}
		}
		const res = await fetch(path, {
			method: init.method,
			body: init.body,
			headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }
		})
		if (!res.ok) throw new Error(`Google API ${res.status}: ${await res.text()}`)
		return res
	}
}

// ── Gmail (email use facet) ──────────────────────────────────────────────

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

export function createGmailEmail(fetch: AuthedFetch): EmailCapability {
	return {
		async listUnread({ limit }) {
			const res = await fetch(`${GMAIL_BASE}/messages?q=is:unread&maxResults=${limit ?? 20}`)
			const { messages = [] } = (await res.json()) as { messages?: { id: string }[] }
			return Promise.all(
				messages.map(async (m) => summarize(await getMessage(fetch, m.id, 'metadata')))
			)
		},
		async readDetail({ id }) {
			return detail(await getMessage(fetch, id, 'full'))
		},
		async markRead({ id }) {
			await fetch(`${GMAIL_BASE}/messages/${id}/modify`, {
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

async function getMessage(
	fetch: AuthedFetch,
	id: string,
	format: 'metadata' | 'full'
): Promise<GmailMessage> {
	const q =
		format === 'metadata'
			? '?format=metadata&metadataHeaders=From&metadataHeaders=Subject'
			: '?format=full'
	return (await (await fetch(`${GMAIL_BASE}/messages/${id}${q}`)).json()) as GmailMessage
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
	return part?.body?.data ? b64urlDecode(part.body.data) : ''
}

function plainText(part: GmailPart | undefined): string | undefined {
	if (!part) return undefined
	if (part.mimeType === 'text/plain' && part.body?.data) return b64urlDecode(part.body.data)
	for (const child of part.parts ?? []) {
		const text = plainText(child)
		if (text !== undefined) return text
	}
	return undefined
}

// Web-standard base64url → utf8 (no node Buffer), so the client runs in a Worker.
function b64urlDecode(data: string): string {
	const b64 = data.replace(/-/g, '+').replace(/_/g, '/')
	const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
	const bin = atob(padded)
	return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

// ── Google Calendar (calendar use facet) ─────────────────────────────────

const GCAL_BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'

export function createGoogleCalendar(fetch: AuthedFetch): CalendarCapability {
	return {
		async listToday({ timezone, now }) {
			const { startMs, endMs } = todayWindow(now ?? Date.now(), timezone)
			const query = new URLSearchParams({
				singleEvents: 'true',
				orderBy: 'startTime',
				timeMin: new Date(startMs).toISOString(),
				timeMax: new Date(endMs).toISOString()
			})
			const res = await fetch(`${GCAL_BASE}?${query.toString()}`)
			const { items = [] } = (await res.json()) as { items?: GoogleEvent[] }
			return items.map(normalize).filter((e): e is CalendarEvent => e !== undefined)
		}
	}
}

interface GoogleEvent {
	id: string
	summary?: string
	location?: string
	start?: { dateTime?: string; date?: string }
	end?: { dateTime?: string; date?: string }
}

function normalize(e: GoogleEvent): CalendarEvent | undefined {
	const startsAt = eventMs(e.start)
	const endsAt = eventMs(e.end)
	if (startsAt === undefined || endsAt === undefined) return undefined
	const event: CalendarEvent = { id: e.id, title: e.summary ?? '(no title)', startsAt, endsAt }
	if (e.location) event.location = e.location
	return event
}

function eventMs(t: { dateTime?: string; date?: string } | undefined): number | undefined {
	if (t?.dateTime) return Date.parse(t.dateTime)
	if (t?.date) return Date.parse(`${t.date}T00:00:00Z`) // all-day: treat as UTC midnight
	return undefined
}

// UTC ms for [today 00:00, tomorrow 00:00) in `timeZone`. +26h lands firmly in the
// next local day even across a DST shift; snapping it back to local midnight gives
// the correct day boundary either way.
function todayWindow(nowMs: number, timeZone: string): { startMs: number; endMs: number } {
	const startMs = localMidnight(nowMs, timeZone)
	return { startMs, endMs: localMidnight(startMs + 26 * 3_600_000, timeZone) }
}

function localMidnight(instantMs: number, timeZone: string): number {
	const p = parts(instantMs, timeZone)
	const utcMidnight = Date.UTC(p.year, p.month - 1, p.day)
	return utcMidnight - offsetMs(utcMidnight, timeZone)
}

function offsetMs(instantMs: number, timeZone: string): number {
	const p = parts(instantMs, timeZone)
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instantMs
}

function parts(instantMs: number, timeZone: string) {
	const fields: Record<string, number> = {}
	for (const part of new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	}).formatToParts(new Date(instantMs))) {
		if (part.type !== 'literal') fields[part.type] = Number(part.value)
	}
	return {
		year: fields.year ?? 0,
		month: fields.month ?? 1,
		day: fields.day ?? 1,
		hour: fields.hour ?? 0,
		minute: fields.minute ?? 0,
		second: fields.second ?? 0
	}
}

// ── Provider assembly ─────────────────────────────────────────────────────

export type OAuthSignIn = (
	requested: string[]
) => Promise<{ accountId: string; creds: Creds; scopes?: string[] }>

export interface GoogleProviderDeps {
	// Host-specific acquisition: loopback (daemon) or web redirect (Worker).
	signIn: OAuthSignIn
	// Client creds for token refresh; null skips refresh (401 → re-auth).
	refreshClient: GoogleClient | null
}

// ONE oauth account backs BOTH email and calendar; per-capability `scopes` drive
// incremental consent (connect grabs identity, enabling a service widens scope).
export function googleProvider(deps: GoogleProviderDeps): Provider {
	return {
		id: 'google',
		name: 'Google',
		auth: {
			kind: 'oauth',
			scopes: { email: [GMAIL_SCOPE], calendar: [CALENDAR_SCOPE] },
			signIn: deps.signIn
		},
		mint: {
			email: (creds) => createGmailEmail(authedFetch(creds as GoogleCreds, deps.refreshClient)),
			calendar: (creds) =>
				createGoogleCalendar(authedFetch(creds as GoogleCreds, deps.refreshClient))
		}
	}
}
