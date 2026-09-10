// The Google provider: one shared module, 100% portable across hosts (Cloudflare
// Worker and the native daemon) — the whole OAuth protocol (PKCE, authorize URL,
// code exchange, refresh, identity extraction) plus the Gmail/Calendar use-facet
// clients, all over web-standard fetch/crypto. What differs per platform comes in
// through the constructor: the `AuthFlow` user agent (loopback browser on the
// daemon, a web redirect or "sign in on desktop" on the Worker) and the OAuth
// CLIENT credentials (a Desktop client's "secret" isn't confidential, but Google
// still wants it on the token call).

import type { CalendarCapability, CalendarEvent } from '../../capabilities/calendar/index.ts'
import type { EmailCapability, EmailDetail, EmailSummary } from '../../capabilities/email/index.ts'
import type { AcquiredAccount, AuthFlow, BoundAccount, Provider } from '../provider.ts'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
// Always requested: the identity scopes that yield the account's email (the
// accountId) from the id_token. Capability scopes widen on top of these.
const IDENTITY_SCOPES = ['openid', 'email']

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'

// The OAuth client credentials the token endpoint requires. Null → connect fails
// with a clear message and refresh is skipped (a near-expiry token is used as-is;
// a resulting 401 surfaces as re-auth) — a synced account still serves.
export interface GoogleClient {
	id: string
	secret: string
}

// What an account from this provider stores: the refresh token IS the account, plus the
// identity it names. Nothing else — the access token is short-lived and re-derivable from
// the refresh token at any time, so it never reaches a record; it lives in memory for this
// process's lifetime (see `Live` below).
export interface GoogleCreds {
	refresh: string
	accountId: string
}

// The live access token, in memory only. Held per account for the lifetime of the
// provider (one per host process), so a cold start costs ONE exchange rather than one per
// capability call — the host binds a fresh client for every call.
interface Live {
	access: string
	expires: number // epoch ms
}

// A cache entry: the token, or the exchange still fetching it. `expires` is readable
// WITHOUT awaiting (Infinity while in flight) — that is what lets the freshness check and
// the write happen in one turn, so two clients can't both decide to refresh.
interface Cached {
	expires: number
	live: Promise<Live>
}

type LiveTokens = Map<string, Cached>

const NEAR_EXPIRY_MS = 60_000

interface TokenResponse {
	access_token: string
	refresh_token?: string
	expires_in: number
	id_token?: string
	scope?: string
}

// Exchange authorization/refresh params for tokens (a plain POST, no browser).
async function googleExchange(
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

// Split in two by where each half is allowed to live: `creds` is the record, `live` never
// leaves memory. Google omits `refresh_token` on refresh, so the old one carries.
async function googleRefresh(
	creds: GoogleCreds,
	client: GoogleClient
): Promise<{ creds: GoogleCreds; live: Live }> {
	const token = await googleExchange(client, {
		grant_type: 'refresh_token',
		refresh_token: creds.refresh
	})
	return {
		creds: { refresh: token.refresh_token ?? creds.refresh, accountId: creds.accountId },
		live: { access: token.access_token, expires: Date.now() + token.expires_in * 1000 }
	}
}

type AuthedFetch = (path: string, init?: { method?: string; body?: string }) => Promise<Response>

// The account's live token, minting one at most ONCE per expiry across every client in this
// process. Deliberately synchronous — read, freshness check and write in a single turn — so
// clients racing a cold start await the same exchange instead of each spending the refresh
// token: Google may rotate it, which invalidates the loser's grant and can leave the last
// writeback storing a dead one. No client (or nothing to refresh with) serves whatever is
// already there; a resulting 401 surfaces as re-auth.
function liveToken(
	account: BoundAccount,
	creds: GoogleCreds,
	client: GoogleClient | null,
	tokens: LiveTokens
): Cached | undefined {
	const id = creds.accountId
	const cached = tokens.get(id)
	if (cached && cached.expires - Date.now() >= NEAR_EXPIRY_MS) return cached
	if (!client || !creds.refresh) return cached
	const entry: Cached = {
		expires: Number.POSITIVE_INFINITY,
		live: googleRefresh(creds, client)
			.then(async ({ creds: rotated, live }) => {
				entry.expires = live.expires
				await account.persist(rotated)
				return live
			})
			.catch((failure: unknown) => {
				// Neither a failed exchange nor a failed writeback is cached: drop the entry so the
				// next call retries rather than reusing a token whose rotation nobody recorded.
				if (tokens.get(id) === entry) tokens.delete(id)
				// A refresh inside the near-expiry window replaced a token that is usually good for
				// another minute. Serve THAT rather than an empty bearer — a blip at the token
				// endpoint must not turn a working call into a failure.
				if (cached) return cached.live
				throw failure
			})
	}
	tokens.set(id, entry)
	return entry
}

// A refresh that failed must not fail the request: fall through with whatever token we have
// and let the 401 surface as re-auth.
async function settled(pending: Promise<Live> | undefined): Promise<Live | undefined> {
	try {
		return await pending
	} catch {
		return undefined
	}
}

// A bearer-attaching fetch over an account, minting/refreshing the token it needs when a
// `refreshClient` is available. Every refresh persists the record, so a rotated refresh
// token survives.
function authedFetch(
	account: BoundAccount,
	refreshClient: GoogleClient | null,
	tokens: LiveTokens
): AuthedFetch {
	const creds = account.creds as GoogleCreds
	return async (path, init = {}) => {
		const live = await settled(liveToken(account, creds, refreshClient, tokens)?.live)
		const res = await fetch(path, {
			method: init.method,
			body: init.body,
			headers: {
				authorization: `Bearer ${live?.access ?? ''}`,
				'content-type': 'application/json'
			}
		})
		if (!res.ok) throw new Error(`Google API ${res.status}: ${await res.text()}`)
		return res
	}
}

// ── Gmail (email use facet) ──────────────────────────────────────────────

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

function createGmailEmail(fetch: AuthedFetch): EmailCapability {
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

function createGoogleCalendar(fetch: AuthedFetch): CalendarCapability {
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

// ── Provider ───────────────────────────────────────────────────────────────

export interface GoogleProviderDeps {
	// The platform's interactive-auth user agent (loopback browser, web redirect, …).
	flow: AuthFlow
	// OAuth client creds for the authorize/token endpoints, or null when unset.
	client: GoogleClient | null
}

export function googleProvider(deps: GoogleProviderDeps): Provider {
	// One live-token cache per provider instance = per host process (see `Live`).
	const tokens: LiveTokens = new Map()
	const authed = (account: BoundAccount) => authedFetch(account, deps.client, tokens)
	return {
		id: 'google',
		name: 'Google',
		auth: { ui: { kind: 'interactive' }, acquire: (input) => acquire(deps, input.scopes, tokens) },
		capabilities: {
			email: { scope: GMAIL_SCOPE, bind: (account) => createGmailEmail(authed(account)) },
			calendar: {
				scope: CALENDAR_SCOPE,
				bind: (account) => createGoogleCalendar(authed(account))
			}
		}
	}
}

// Run the consent flow (PKCE) for the union of identity + `requested` scopes through
// the platform's AuthFlow, exchange the code, and return the tokens, the account's
// email, and the scopes Google actually granted (recorded for incremental consent).
// The access token the exchange yields goes into `tokens` — in memory, so connecting and
// then immediately using the account costs no second exchange — and never into the record.
async function acquire(
	deps: GoogleProviderDeps,
	requested: string[],
	tokens: LiveTokens
): Promise<AcquiredAccount> {
	const { flow, client } = deps
	const verifier = randomB64url(32)
	const challenge = b64url(
		new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
	)
	const state = randomB64url(16)
	const scope = [...new Set([...IDENTITY_SCOPES, ...requested])].join(' ')
	let redirectUri = ''
	const callback = await flow.authorize((uri) => {
		if (!client)
			throw new Error(
				'Google sign-in needs GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in the environment'
			)
		redirectUri = uri
		const url = new URL(AUTH_URL)
		url.search = new URLSearchParams({
			client_id: client.id,
			redirect_uri: uri,
			response_type: 'code',
			scope,
			code_challenge: challenge,
			code_challenge_method: 'S256',
			access_type: 'offline',
			include_granted_scopes: 'true',
			prompt: 'consent',
			state
		}).toString()
		return url.toString()
	})
	const code = callback.searchParams.get('code')
	if (!client || !code || callback.searchParams.get('state') !== state)
		throw new Error('Google sign-in failed or was cancelled')
	const token = await googleExchange(client, {
		grant_type: 'authorization_code',
		code,
		redirect_uri: redirectUri,
		code_verifier: verifier
	})
	const accountId = emailFromIdToken(token.id_token) ?? ''
	const creds: GoogleCreds = { refresh: token.refresh_token ?? '', accountId }
	const live: Live = { access: token.access_token, expires: Date.now() + token.expires_in * 1000 }
	tokens.set(accountId, { expires: live.expires, live: Promise.resolve(live) })
	return { accountId, creds, scopes: (token.scope ?? scope).split(' ').filter(Boolean) }
}

// Web-standard base64url over raw bytes (no node Buffer), so the flow runs anywhere.
function b64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '')
}

function randomB64url(n: number): string {
	return b64url(crypto.getRandomValues(new Uint8Array(n)))
}

function emailFromIdToken(idToken: string | undefined): string | undefined {
	const payload = idToken?.split('.')[1]
	if (!payload) return undefined
	try {
		return (JSON.parse(b64urlDecode(payload)) as { email?: string }).email
	} catch {
		return undefined
	}
}
