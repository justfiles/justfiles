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
