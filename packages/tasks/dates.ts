/**
 * Pure timezone-aware date utilities.
 *
 * All date arithmetic for tasks happens in a single configured timezone.
 * Resolution chain (highest precedence first):
 *   1. --tz CLI flag
 *   2. TASKS_TZ environment variable
 *   3. timezone option passed to createTaskManager
 *   4. system local timezone
 */

export type ResolveTimezoneInput = {
	flag?: string | undefined
	env?: string | undefined
	option?: string | undefined
}

export function systemTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone
}

export function resolveTimezone(src: ResolveTimezoneInput = {}): string {
	if (src.flag && src.flag.length > 0) return src.flag
	if (src.env && src.env.length > 0) return src.env
	if (src.option && src.option.length > 0) return src.option
	return systemTimezone()
}

export function isValidTimezone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: tz })
		return true
	} catch {
		return false
	}
}

function dateParts(now: Date, tz: string) {
	const fmt = new Intl.DateTimeFormat('en-US', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23'
	})
	const parts = fmt.formatToParts(now)
	const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
	return {
		year: get('year'),
		month: get('month'),
		day: get('day'),
		hour: get('hour'),
		minute: get('minute'),
		second: get('second')
	}
}

export function today(tz: string, now: Date = new Date()): string {
	const { year, month, day } = dateParts(now, tz)
	return `${year}${month}${day}`
}

export function nowTimestamp(tz: string, now: Date = new Date()): string {
	const { year, month, day, hour, minute, second } = dateParts(now, tz)
	return `${year}${month}${day}T${hour}${minute}${second}`
}

export function isOverdue(
	due: string | undefined,
	status: string,
	tz: string,
	now: Date = new Date()
): boolean {
	if (!due) return false
	if (status !== 'TODO') return false
	return due < today(tz, now)
}

const WEEKDAY_SHORT = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const WEEKDAY_LONG: Record<string, number> = {
	sunday: 0,
	monday: 1,
	tuesday: 2,
	wednesday: 3,
	thursday: 4,
	friday: 5,
	saturday: 6
}

function addDays(dateStr: string, n: number): string {
	const y = parseInt(dateStr.slice(0, 4), 10)
	const mo = parseInt(dateStr.slice(4, 6), 10) - 1
	const d = parseInt(dateStr.slice(6, 8), 10)
	const dt = new Date(Date.UTC(y, mo, d))
	dt.setUTCDate(dt.getUTCDate() + n)
	return (
		String(dt.getUTCFullYear()) +
		String(dt.getUTCMonth() + 1).padStart(2, '0') +
		String(dt.getUTCDate()).padStart(2, '0')
	)
}

function dowOfDateStr(dateStr: string): number {
	const y = parseInt(dateStr.slice(0, 4), 10)
	const mo = parseInt(dateStr.slice(4, 6), 10) - 1
	const d = parseInt(dateStr.slice(6, 8), 10)
	return new Date(Date.UTC(y, mo, d)).getUTCDay()
}

const PARSE_DUE_HELP =
	'accepted: today, tomorrow, yesterday, next week, next month, next year, weekday name (mon/monday/…), +Nd/+Nw/+Nm/+Ny, or YYYYMMDD'

export function parseDueInput(input: string, tz: string, now: Date = new Date()): string {
	const norm = input.trim().toLowerCase()
	const todayStr = today(tz, now)

	if (/^\d{8}$/.test(norm)) return norm

	if (norm === 'today') return todayStr
	if (norm === 'tomorrow') return addDays(todayStr, 1)
	if (norm === 'yesterday') return addDays(todayStr, -1)
	if (norm === 'next week') return addDays(todayStr, 7)
	if (norm === 'next month') return addDays(todayStr, 30)
	if (norm === 'next year') return addDays(todayStr, 365)

	const shortIdx = WEEKDAY_SHORT.indexOf(norm)
	const longIdx = WEEKDAY_LONG[norm] ?? -1
	const targetDow = shortIdx >= 0 ? shortIdx : longIdx
	if (targetDow >= 0) {
		const diff = (targetDow - dowOfDateStr(todayStr) + 7) % 7 || 0
		return addDays(todayStr, diff)
	}

	const relative = /^\+(\d+)([dwmy])$/.exec(norm)
	if (relative) {
		const amount = relative[1]
		const unit = relative[2]
		if (!amount || !unit) throw new Error(`invalid date: "${input}" — ${PARSE_DUE_HELP}`)
		const n = parseInt(amount, 10)
		const days = unit === 'd' ? n : unit === 'w' ? n * 7 : unit === 'm' ? n * 30 : n * 365
		return addDays(todayStr, days)
	}

	throw new Error(`invalid date: "${input}" — ${PARSE_DUE_HELP}`)
}
