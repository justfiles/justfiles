// Calendar dates and times in the user's time zone, copied from packages/agent/timezone.ts.

export const DEFAULT_TIMEZONE = 'UTC'

/** `YYYY-MM-DD` of `at` in `tz`. */
export function dayInTz(at: Date, tz: string): string {
	const parts = new Intl.DateTimeFormat('en-GB', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(at)
	const get = (t: string) => parts.find((p) => p.type === t)?.value
	return `${get('year')}-${get('month')}-${get('day')}`
}

/**
 * The `YYYY-MM-DD` day `at` belongs to when a day starts at `atHour` in `tz`: 03:59 is still
 * the day before when `atHour` is 4. The clock is shifted back by whole hours, so on a
 * daylight-saving day the boundary moves by an hour.
 */
export function sessionDay(at: Date, tz: string, atHour: number): string {
	return dayInTz(new Date(at.getTime() - atHour * 3_600_000), tz)
}

/** The calendar day before `day`, both `YYYY-MM-DD`. */
export function dayBefore(day: string): string {
	const [y, m, d] = day.split('-').map(Number) as [number, number, number]
	return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
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

function pad2(n: number): string {
	return String(n).padStart(2, '0')
}
