import type { Volume } from '@justfiles/fs'
import { parseFrontmatter } from './markdown'

export const DEFAULT_TIMEZONE = 'UTC'
const PROFILE_PATH = '/system/user.md'

export async function resolveTimezone(
	volume: Volume,
	cfTimezone: string | undefined
): Promise<string> {
	if (await volume.exists(PROFILE_PATH)) {
		const fm = parseFrontmatter(new TextDecoder().decode(await volume.readFile(PROFILE_PATH)))
		if (fm.timezone) return fm.timezone
	}
	return cfTimezone ?? DEFAULT_TIMEZONE
}

export function dateInTz(at: Date, tz: string): { year: number; month: number; day: number } {
	const parts = new Intl.DateTimeFormat('en-GB', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(at)
	const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
	return { year: get('year'), month: get('month'), day: get('day') }
}

export function zonedTimeToUtcMs(
	y: number,
	mo: number,
	d: number,
	h: number,
	mi: number,
	s: number,
	tz: string
): number {
	const asUtc = Date.UTC(y, mo - 1, d, h, mi, s)
	const fmt = new Intl.DateTimeFormat('en-GB', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	})
	const parts = fmt.formatToParts(new Date(asUtc))
	const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
	const displayedUtc = Date.UTC(
		get('year'),
		get('month') - 1,
		get('day'),
		get('hour') === 24 ? 0 : get('hour'),
		get('minute'),
		get('second')
	)
	return asUtc + (asUtc - displayedUtc)
}

function pad2(n: number): string {
	return String(n).padStart(2, '0')
}

// Returns ISO 8601 with timezone offset, e.g. "2026-05-04T10:30:00-04:00".
// Falls back to a 'Z' suffix for UTC.
export function formatInTimezone(at: Date, tz: string): string {
	try {
		const fmt = new Intl.DateTimeFormat('en-GB', {
			timeZone: tz,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hour12: false
		})
		const parts = fmt.formatToParts(at)
		const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
		const hour = get('hour') === '24' ? '00' : get('hour')
		const local = `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}`
		const naiveUtc = Date.UTC(
			Number(get('year')),
			Number(get('month')) - 1,
			Number(get('day')),
			Number(hour),
			Number(get('minute')),
			Number(get('second'))
		)
		const offsetMin = Math.round((naiveUtc - at.getTime()) / 60000)
		if (offsetMin === 0) return `${local}Z`
		const sign = offsetMin >= 0 ? '+' : '-'
		const abs = Math.abs(offsetMin)
		return `${local}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
	} catch {
		return at.toISOString().replace(/\.\d{3}Z$/, 'Z')
	}
}

// Converts an ISO-ish timestamp string to local-tz ISO. If the input is a
// date-only string (YYYY-MM-DD), it is returned unchanged (all-day event).
export function isoToTimezone(iso: string, tz: string): string {
	if (iso.length === 10) return iso
	const d = new Date(iso)
	if (Number.isNaN(d.getTime())) return iso
	return formatInTimezone(d, tz)
}

export function nextFourAmInTimezone(now: Date, tz: string): number | null {
	try {
		const { year, month, day } = dateInTz(now, tz)
		const today4am = zonedTimeToUtcMs(year, month, day, 4, 0, 0, tz)
		if (today4am > now.getTime()) return today4am
		const next = new Date(Date.UTC(year, month - 1, day) + 86400000)
		return zonedTimeToUtcMs(
			next.getUTCFullYear(),
			next.getUTCMonth() + 1,
			next.getUTCDate(),
			4,
			0,
			0,
			tz
		)
	} catch {
		return null
	}
}
