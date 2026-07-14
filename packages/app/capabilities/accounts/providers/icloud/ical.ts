export interface CalEvent {
	uid: string
	summary: string
	dtstart: string
	dtend: string
	description?: string
	location?: string
	href?: string
}

function unfold(raw: string): string {
	return raw.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '')
}

function parseUtcDateTime(s: string): string {
	const y = s.slice(0, 4)
	const mo = s.slice(4, 6)
	const d = s.slice(6, 8)
	const h = s.slice(9, 11)
	const mi = s.slice(11, 13)
	const sec = s.slice(13, 15)
	return `${y}-${mo}-${d}T${h}:${mi}:${sec}Z`
}

export function localToUtc(localDateStr: string, tzid: string): string {
	const y = +localDateStr.slice(0, 4)
	const mo = +localDateStr.slice(4, 6) - 1
	const d = +localDateStr.slice(6, 8)
	const h = +localDateStr.slice(9, 11)
	const mi = +localDateStr.slice(11, 13)
	const s = +(localDateStr.slice(13, 15) || '0')

	const approxUtc = Date.UTC(y, mo, d, h, mi, s)

	const fmt = new Intl.DateTimeFormat('en-US', {
		timeZone: tzid,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	})

	const parts = fmt.formatToParts(new Date(approxUtc))
	const p: Record<string, string> = {}
	for (const { type, value } of parts) p[type] = value

	const tzYear = +(p.year ?? '0')
	const tzMonth = +(p.month ?? '1') - 1
	const tzDay = +(p.day ?? '1')
	const tzHour = p.hour === '24' ? 0 : +(p.hour ?? '0')
	const tzMin = +(p.minute ?? '0')
	const tzSec = +(p.second ?? '0')

	const tzAsUtcMs = Date.UTC(tzYear, tzMonth, tzDay, tzHour, tzMin, tzSec)
	return new Date(2 * approxUtc - tzAsUtcMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function parseDateValue(prop: string): string {
	const colonIdx = prop.indexOf(':')
	const propName = prop.slice(0, colonIdx)
	const value = prop.slice(colonIdx + 1)

	if (propName.includes('VALUE=DATE')) {
		return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
	}

	if (value.endsWith('Z')) {
		return parseUtcDateTime(value)
	}

	const tzidMatch = propName.match(/TZID=([^;:]+)/)
	if (tzidMatch) {
		return localToUtc(value, tzidMatch[1] ?? '')
	}

	// Floating time — no timezone specifier; treat as UTC
	console.warn(`ical: floating time "${value}" treated as UTC`)
	return parseUtcDateTime(`${value}Z`)
}

function toIcsDate(iso: string): string {
	if (iso.length === 10) {
		return iso.replace(/-/g, '')
	}
	return iso.replace(/-/g, '').replace(/:/g, '')
}

export function parseIcs(raw: string): CalEvent[] {
	const lines = unfold(raw).split(/\r?\n/)
	const events: CalEvent[] = []
	let current: Partial<CalEvent> | null = null

	for (const line of lines) {
		if (line === 'BEGIN:VEVENT') {
			current = {}
		} else if (line === 'END:VEVENT') {
			if (current?.uid && current.summary !== undefined && current.dtstart && current.dtend) {
				events.push(current as CalEvent)
			}
			current = null
		} else if (current !== null) {
			if (line.startsWith('UID:')) {
				current.uid = line.slice(4)
			} else if (line.startsWith('SUMMARY:')) {
				current.summary = line.slice(8)
			} else if (line.startsWith('DTSTART')) {
				current.dtstart = parseDateValue(line)
			} else if (line.startsWith('DTEND')) {
				current.dtend = parseDateValue(line)
			} else if (line.startsWith('DESCRIPTION:')) {
				current.description = line.slice(12)
			} else if (line.startsWith('LOCATION:')) {
				current.location = line.slice(9)
			}
		}
	}

	return events
}

export function generateIcs(event: Omit<CalEvent, 'href'>): string {
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//frieren//icloud-calendar//EN',
		'BEGIN:VEVENT',
		`UID:${event.uid}`,
		`SUMMARY:${event.summary}`,
		`DTSTART${event.dtstart.length === 10 ? ';VALUE=DATE' : ''}:${toIcsDate(event.dtstart)}`,
		`DTEND${event.dtend.length === 10 ? ';VALUE=DATE' : ''}:${toIcsDate(event.dtend)}`
	]

	if (event.description) lines.push(`DESCRIPTION:${event.description}`)
	if (event.location) lines.push(`LOCATION:${event.location}`)

	lines.push('END:VEVENT', 'END:VCALENDAR')
	return `${lines.join('\r\n')}\r\n`
}
