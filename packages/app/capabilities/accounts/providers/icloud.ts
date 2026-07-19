// iCloud provider for the Calendar capability. Reuses the CalDAV client and
// iCalendar parser from `worker/integrations/icloud-calendar`. Translates raw
// VEVENT data into normalized `CalendarEvent` DTOs and never lets credentials
// or raw iCalendar payloads leak into the result.

import type { CalendarCapability, CalendarEvent } from '../../calendar/index.ts'
import type { CredentialsSchema } from '../contract.ts'
import type { Provider } from '../provider.ts'
import { type CalDavClient, createCalDavClient } from './icloud/caldav.ts'
import { type CalEvent, localToUtc } from './icloud/ical.ts'

export interface IcloudCalendarCredentials {
	username: string
	password: string
	accountId?: string
}

export interface IcloudCalendarProviderOptions {
	createClient?: (credentials: IcloudCalendarCredentials) => CalDavClient
}

// A plain `{ id, create }` provider — the accounts registry mints `create(creds)`
// per call to back the `calendar` capability. No broker.
export function createIcloudCalendarProvider(options: IcloudCalendarProviderOptions = {}) {
	const createClient = options.createClient ?? defaultCreateClient
	return {
		id: 'icloud',
		name: 'iCloud Calendar',
		description: 'Read iCloud Calendar events via CalDAV',
		create(credentials: unknown): CalendarCapability {
			const creds = credentials as IcloudCalendarCredentials
			const client = createClient(creds)
			const fallbackAccountId = creds.accountId
			return {
				async listToday(input) {
					const nowMs = input.now ?? Date.now()
					const bounds = todayBoundsInTz(nowMs, input.timezone)
					const accountId = input.accountId ?? fallbackAccountId
					const raw = await client.listEventsBetween(
						new Date(bounds.startMs),
						new Date(bounds.endMs)
					)
					return raw
						.map((event) => normalize(event, input.timezone, accountId, bounds))
						.filter((event): event is CalendarEvent => event !== undefined)
						.sort((a, b) => a.startsAt - b.startsAt)
				}
			}
		}
	}
}

function defaultCreateClient(credentials: IcloudCalendarCredentials): CalDavClient {
	return createCalDavClient({ username: credentials.username, password: credentials.password })
}

interface DayBounds {
	startMs: number
	endMs: number
}

// Compute UTC ms for [today 00:00, tomorrow 00:00) in the given IANA timezone.
function todayBoundsInTz(nowMs: number, timezone: string): DayBounds {
	const today = formatYmdInTz(new Date(nowMs), timezone)
	const tomorrow = addOneDay(today)
	return {
		startMs: Date.parse(localToUtc(`${today.y}${today.m}${today.d}T000000`, timezone)),
		endMs: Date.parse(localToUtc(`${tomorrow.y}${tomorrow.m}${tomorrow.d}T000000`, timezone))
	}
}

interface Ymd {
	y: string
	m: string
	d: string
}

function formatYmdInTz(date: Date, timezone: string): Ymd {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: timezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(date)
	const map: Record<string, string> = {}
	for (const p of parts) map[p.type] = p.value
	return { y: map.year ?? '', m: map.month ?? '', d: map.day ?? '' }
}

function addOneDay(date: Ymd): Ymd {
	const next = new Date(Date.UTC(+date.y, +date.m - 1, +date.d + 1))
	const pad = (n: number) => String(n).padStart(2, '0')
	return {
		y: String(next.getUTCFullYear()),
		m: pad(next.getUTCMonth() + 1),
		d: pad(next.getUTCDate())
	}
}

function isDateOnly(value: string): boolean {
	return value.length === 10
}

function eventBounds(event: CalEvent, timezone: string): { startMs: number; endMs: number } {
	const startMs = isDateOnly(event.dtstart)
		? Date.parse(localToUtc(`${event.dtstart.replaceAll('-', '')}T000000`, timezone))
		: Date.parse(event.dtstart)
	const endMs = isDateOnly(event.dtend)
		? Date.parse(localToUtc(`${event.dtend.replaceAll('-', '')}T000000`, timezone))
		: Date.parse(event.dtend)
	return { startMs, endMs }
}

function normalize(
	event: CalEvent,
	timezone: string,
	accountId: string | undefined,
	bounds: DayBounds
): CalendarEvent | undefined {
	const { startMs, endMs } = eventBounds(event, timezone)
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return undefined
	if (endMs <= bounds.startMs || startMs >= bounds.endMs) return undefined
	const normalized: CalendarEvent = {
		id: event.uid,
		title: event.summary,
		startsAt: startMs,
		endsAt: endMs
	}
	if (event.location) normalized.location = event.location
	if (accountId !== undefined) normalized.accountId = accountId
	return normalized
}

// ── Provider ───────────────────────────────────────────────────────────────

const ICLOUD_SCHEMA: CredentialsSchema = {
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

// A form provider: acquisition is the submitted fields themselves, keyed by the
// Apple ID (so several iCloud accounts can coexist). No scope on calendar — the
// capability is granted by the account existing; to stop it, disconnect.
export function icloudProvider(options: IcloudCalendarProviderOptions = {}): Provider {
	const inner = createIcloudCalendarProvider(options)
	return {
		id: 'icloud',
		name: 'iCloud',
		auth: {
			ui: { kind: 'form', schema: ICLOUD_SCHEMA },
			acquire: async ({ fields }) => {
				const username = fields?.username?.trim()
				const password = fields?.password
				if (!username || !password)
					throw new Error('iCloud needs an Apple ID and an app-specific password')
				return { accountId: username, creds: { username, password, accountId: username } }
			}
		},
		capabilities: { calendar: { bind: (account) => inner.create(account.creds) } }
	}
}
