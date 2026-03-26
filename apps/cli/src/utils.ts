/**
 * Resolve a user-supplied date/duration string into a full ISO 8601 datetime.
 *
 * Accepted formats:
 *   Relative duration   "7d", "2w", "1m", "3h", "30m"   → exact timestamp N ago
 *   Natural words       "today", "yesterday"             → start/end of that day
 *   Date only           "2026-03-01"                     → start/end of that day
 *   Full ISO datetime   "2026-03-01T14:30:00Z"           → passed through as-is
 *
 * @param input  Raw user input
 * @param side   "since" → inclusive lower bound (T00:00:00.000Z for date-only)
 *               "until" → inclusive upper bound (T23:59:59.999Z for date-only)
 */
export function resolveDate(input: string, side: 'since' | 'until'): string {
	const s = input.trim().toLowerCase()

	// Relative duration: 7d, 2w, 1m, 3h, 30m
	const duration = parseDuration(s)
	if (duration !== null) {
		return new Date(Date.now() - duration).toISOString()
	}

	if (s === 'today') return dayBound(new Date(), side)
	if (s === 'yesterday') {
		const d = new Date()
		d.setUTCDate(d.getUTCDate() - 1)
		return dayBound(d, side)
	}

	// Full ISO datetime — pass through unchanged
	if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return input

	// Date-only YYYY-MM-DD → fill in time based on side
	if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
		return side === 'until' ? `${s}T23:59:59.999Z` : `${s}T00:00:00.000Z`
	}

	// Unrecognised — return as-is and let the server validate
	return input
}

/**
 * Parse a duration string into milliseconds.
 * Supported units: m (minutes), h (hours), d (days), w (weeks), mo (months, ~30d)
 * Returns null if the input is not a recognised duration.
 */
function parseDuration(s: string): number | null {
	const match = s.match(/^(\d+(?:\.\d+)?)(mo|m|h|d|w)$/)
	if (!match) return null
	const n = parseFloat(match[1])
	const unit = match[2]
	const MS = {
		m: 60_000,
		h: 3_600_000,
		d: 86_400_000,
		w: 7 * 86_400_000,
		mo: 30 * 86_400_000,
	}
	return n * (MS[unit as keyof typeof MS] ?? 0)
}

function dayBound(d: Date, side: 'since' | 'until'): string {
	const ymd = d.toISOString().slice(0, 10)
	return side === 'until' ? `${ymd}T23:59:59.999Z` : `${ymd}T00:00:00.000Z`
}
