// Google Calendar REST client behind the `calendar` use facet. listToday asks the
// primary calendar for events in the [local-midnight, next-local-midnight) window
// (singleEvents expands recurrences). The fan-out host stamps each event with its
// accountId, so the merged view tells Google events from iCloud ones.

import type { CalendarCapability, CalendarEvent } from '@justfiles/app/capabilities/calendar'
import type { AuthedFetch } from './oauth'

const BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'

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
			const res = await fetch(`${BASE}?${query.toString()}`)
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
		year: fields.year,
		month: fields.month,
		day: fields.day,
		hour: fields.hour,
		minute: fields.minute,
		second: fields.second
	}
}
