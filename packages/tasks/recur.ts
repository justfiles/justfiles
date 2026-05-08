import type { Recur } from './parse.ts'

const WEEKDAY: Record<string, number> = {
	sun: 0,
	mon: 1,
	tue: 2,
	wed: 3,
	thu: 4,
	fri: 5,
	sat: 6
}

const ALIASES = new Set(['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'])

export function isValidInterval(interval: string): boolean {
	if (ALIASES.has(interval)) return true
	if (interval in WEEKDAY) return true
	if (/^[1-9]\d*[dwmy]$/.test(interval)) return true
	return false
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

function addMonths(dateStr: string, n: number): string {
	const y = parseInt(dateStr.slice(0, 4), 10)
	const mo = parseInt(dateStr.slice(4, 6), 10) - 1
	const d = parseInt(dateStr.slice(6, 8), 10)
	const totalMonths = mo + n
	const newYear = y + Math.floor(totalMonths / 12)
	const newMonth = ((totalMonths % 12) + 12) % 12
	const daysInMonth = new Date(Date.UTC(newYear, newMonth + 1, 0)).getUTCDate()
	return (
		String(newYear) +
		String(newMonth + 1).padStart(2, '0') +
		String(Math.min(d, daysInMonth)).padStart(2, '0')
	)
}

function dowOf(dateStr: string): number {
	const y = parseInt(dateStr.slice(0, 4), 10)
	const mo = parseInt(dateStr.slice(4, 6), 10) - 1
	const d = parseInt(dateStr.slice(6, 8), 10)
	return new Date(Date.UTC(y, mo, d)).getUTCDay()
}

// Advance dateStr by one interval; for weekdays, jumps to the next occurrence (≥ 1 day ahead).
export function addInterval(dateStr: string, interval: string): string {
	switch (interval) {
		case 'daily':
			return addDays(dateStr, 1)
		case 'weekly':
			return addDays(dateStr, 7)
		case 'biweekly':
			return addDays(dateStr, 14)
		case 'monthly':
			return addMonths(dateStr, 1)
		case 'quarterly':
			return addMonths(dateStr, 3)
		case 'yearly':
			return addMonths(dateStr, 12)
	}
	const numeric = /^(\d+)([dwmy])$/.exec(interval)
	if (numeric) {
		const amount = numeric[1]
		const unit = numeric[2]
		if (!amount || !unit) throw new Error(`invalid recurrence interval: ${interval}`)
		const n = parseInt(amount, 10)
		if (unit === 'd') return addDays(dateStr, n)
		if (unit === 'w') return addDays(dateStr, n * 7)
		if (unit === 'm') return addMonths(dateStr, n)
		if (unit === 'y') return addMonths(dateStr, n * 12)
	}
	const targetDow = WEEKDAY[interval]
	if (targetDow !== undefined) {
		const diff = (targetDow - dowOf(dateStr) + 7) % 7 || 7
		return addDays(dateStr, diff)
	}
	throw new Error(`invalid recurrence interval: ${interval}`)
}

/**
 * Compute the next due date for a recurring task.
 *
 * - catchup: advance original due by the interval until the result is after completedAt
 * - restart: completedAt + interval
 * - fixed:   original due + interval (may remain in the past)
 */
export function nextDue(due: string | undefined, recur: Recur, completedAt: string): string {
	const { type, interval } = recur
	const isWeekday = interval in WEEKDAY

	switch (type) {
		case 'catchup': {
			if (!due) return addInterval(completedAt, interval)
			let date = due
			while (date <= completedAt) {
				date = isWeekday ? addDays(date, 7) : addInterval(date, interval)
			}
			return date
		}
		case 'restart':
			return addInterval(completedAt, interval)
		case 'fixed': {
			const base = due ?? completedAt
			return isWeekday ? addDays(base, 7) : addInterval(base, interval)
		}
		default:
			throw new Error(`unknown recurrence type: ${type}`)
	}
}
