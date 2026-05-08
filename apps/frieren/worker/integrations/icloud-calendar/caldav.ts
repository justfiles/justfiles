import { type CalEvent, generateIcs, parseIcs } from './ical.ts'

const BASE_URL = 'https://caldav.icloud.com'

export interface CalDavClientOptions {
	username: string
	password: string
	fetch?: typeof globalThis.fetch
	baseUrl?: string
}

export interface CreateEventInput {
	summary: string
	dtstart: string
	durationMinutes?: number
	description?: string
	location?: string
}

export interface CalDavClient {
	listEvents(options?: { days?: number }): Promise<CalEvent[]>
	listEventsBetween(start: Date, end: Date): Promise<CalEvent[]>
	readEvent(uid: string): Promise<CalEvent>
	createEvent(input: CreateEventInput): Promise<{ uid: string }>
	deleteEvent(uid: string): Promise<void>
}

interface CalDavSession {
	principalUrl: string
	homeUrl: string
	calendars: string[]
}

const AUTH_HINT =
	'iCloud rejected the credentials (401). Generate a new app-specific password at appleid.apple.com → Sign-In and Security → App-Specific Passwords.'

function basicAuth(username: string, password: string): string {
	return `Basic ${btoa(`${username}:${password}`)}`
}

function localNamePattern(name: string): string {
	return `(?:[A-Za-z0-9_-]+:)?${name}`
}

function extractText(xml: string, name: string): string | undefined {
	const re = new RegExp(
		`<${localNamePattern(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${localNamePattern(name)}>`
	)
	const match = xml.match(re)
	return match?.[1]
}

function extractAll(xml: string, name: string): string[] {
	const re = new RegExp(
		`<${localNamePattern(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${localNamePattern(name)}>`,
		'g'
	)
	const out: string[] = []
	let m: RegExpExecArray | null = re.exec(xml)
	while (m !== null) {
		out.push(m[1])
		m = re.exec(xml)
	}
	return out
}

function extractHrefs(xml: string): string[] {
	return extractAll(xml, 'href').map((s) => s.trim())
}

function absoluteUrl(baseUrl: string, path: string): string {
	if (/^https?:\/\//.test(path)) return path
	const u = new URL(baseUrl)
	return `${u.protocol}//${u.host}${path}`
}

function pad2(n: number): string {
	return String(n).padStart(2, '0')
}

function utcStamp(date: Date): string {
	return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}T${pad2(
		date.getUTCHours()
	)}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`
}

function escapeXml(s: string): string {
	return s.replace(/[<>&"']/g, (c) =>
		c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === '"' ? '&quot;' : '&apos;'
	)
}

function decodeXml(s: string): string {
	return s.replace(/&(lt|gt|amp|quot|apos);/g, (_, e) =>
		e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'amp' ? '&' : e === 'quot' ? '"' : "'"
	)
}

function addDaysAllDay(date: string, days: number): string {
	const y = +date.slice(0, 4)
	const mo = +date.slice(5, 7) - 1
	const d = +date.slice(8, 10)
	const next = new Date(Date.UTC(y, mo, d + days))
	return `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`
}

function addMinutesIso(iso: string, minutes: number): string {
	const ms = new Date(iso).getTime() + minutes * 60_000
	return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function describeStatus(status: number, kind: string): string {
	if (status === 401) return AUTH_HINT
	return `caldav ${kind} failed: ${status}`
}

export function createCalDavClient(opts: CalDavClientOptions): CalDavClient {
	const fetchFn = opts.fetch ?? globalThis.fetch
	const baseUrl = opts.baseUrl ?? BASE_URL
	const auth = basicAuth(opts.username, opts.password)
	let sessionPromise: Promise<CalDavSession> | undefined

	function send(
		method: string,
		url: string,
		init: { headers?: Record<string, string>; body?: string } = {}
	): Promise<Response> {
		return fetchFn(url, {
			method,
			headers: { Authorization: auth, ...(init.headers ?? {}) },
			body: init.body
		})
	}

	async function discoverPrincipal(): Promise<string> {
		const body = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
	<D:prop><D:current-user-principal/></D:prop>
</D:propfind>`
		const res = await send('PROPFIND', `${baseUrl}/`, {
			headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
			body
		})
		if (!res.ok) throw new Error(describeStatus(res.status, 'principal discovery'))
		const xml = await res.text()
		const block = extractText(xml, 'current-user-principal')
		if (!block) throw new Error('caldav: no current-user-principal in response')
		const href = extractHrefs(block)[0]
		if (!href) throw new Error('caldav: no principal href')
		return absoluteUrl(baseUrl, href)
	}

	async function discoverHome(principalUrl: string): Promise<string> {
		const body = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
	<D:prop><C:calendar-home-set/></D:prop>
</D:propfind>`
		const res = await send('PROPFIND', principalUrl, {
			headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
			body
		})
		if (!res.ok) throw new Error(describeStatus(res.status, 'home discovery'))
		const xml = await res.text()
		const block = extractText(xml, 'calendar-home-set')
		if (!block) throw new Error('caldav: no calendar-home-set in response')
		const href = extractHrefs(block)[0]
		if (!href) throw new Error('caldav: no home href')
		return absoluteUrl(baseUrl, href)
	}

	async function discoverCalendars(homeUrl: string): Promise<string[]> {
		const body = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
	<D:prop>
		<D:resourcetype/>
		<C:supported-calendar-component-set/>
	</D:prop>
</D:propfind>`
		const res = await send('PROPFIND', homeUrl, {
			headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
			body
		})
		if (!res.ok) throw new Error(describeStatus(res.status, 'list calendars'))
		const xml = await res.text()
		const responses = extractAll(xml, 'response')
		const home = homeUrl.replace(/\/$/, '')
		const calendars: string[] = []
		for (const resp of responses) {
			const href = extractHrefs(resp)[0]
			if (!href) continue
			const resourcetype = extractText(resp, 'resourcetype') ?? ''
			if (!/<(?:[A-Za-z0-9_-]+:)?calendar(?:\s[^>]*)?\/?>/i.test(resourcetype)) continue
			const supported = extractText(resp, 'supported-calendar-component-set') ?? ''
			if (!/name=["']VEVENT["']/i.test(supported)) continue
			const calUrl = absoluteUrl(baseUrl, href)
			if (calUrl.replace(/\/$/, '') === home) continue
			calendars.push(calUrl)
		}
		return calendars
	}

	async function loadSession(): Promise<CalDavSession> {
		const principalUrl = await discoverPrincipal()
		const homeUrl = await discoverHome(principalUrl)
		const calendars = await discoverCalendars(homeUrl)
		return { principalUrl, homeUrl, calendars }
	}

	function session(): Promise<CalDavSession> {
		if (!sessionPromise) sessionPromise = loadSession()
		return sessionPromise
	}

	async function calendarQuery(
		calendarUrl: string,
		filter: string
	): Promise<Array<{ href: string; ics: string }>> {
		const body = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
	<D:prop>
		<D:getetag/>
		<C:calendar-data/>
	</D:prop>
	<C:filter>${filter}</C:filter>
</C:calendar-query>`
		const res = await send('REPORT', calendarUrl, {
			headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
			body
		})
		if (!res.ok) throw new Error(describeStatus(res.status, 'report'))
		const xml = await res.text()
		const out: Array<{ href: string; ics: string }> = []
		for (const resp of extractAll(xml, 'response')) {
			const href = extractHrefs(resp)[0]
			const ics = extractText(resp, 'calendar-data')
			if (href && ics) out.push({ href: absoluteUrl(baseUrl, href), ics: decodeXml(ics).trim() })
		}
		return out
	}

	async function findByUid(uid: string): Promise<{ event: CalEvent; href: string } | undefined> {
		const filter = `<C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:prop-filter name="UID"><C:text-match>${escapeXml(uid)}</C:text-match></C:prop-filter></C:comp-filter></C:comp-filter>`
		const s = await session()
		for (const cal of s.calendars) {
			const items = await calendarQuery(cal, filter)
			for (const item of items) {
				const found = parseIcs(item.ics).find((e) => e.uid === uid)
				if (found) return { event: { ...found, href: item.href }, href: item.href }
			}
		}
		return undefined
	}

	async function listEventsBetween(start: Date, end: Date): Promise<CalEvent[]> {
		const filter = `<C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="${utcStamp(start)}" end="${utcStamp(end)}"/></C:comp-filter></C:comp-filter>`
		const s = await session()
		const all: CalEvent[] = []
		for (const cal of s.calendars) {
			const items = await calendarQuery(cal, filter)
			for (const item of items) {
				for (const ev of parseIcs(item.ics)) all.push({ ...ev, href: item.href })
			}
		}
		return all
	}

	return {
		async listEvents(options = {}) {
			const days = options.days ?? 7
			const start = new Date()
			const end = new Date(start.getTime() + days * 24 * 60 * 60 * 1000)
			return listEventsBetween(start, end)
		},

		listEventsBetween,

		async readEvent(uid) {
			const found = await findByUid(uid)
			if (!found) throw new Error(`caldav: event ${uid} not found`)
			return found.event
		},

		async createEvent(input) {
			const s = await session()
			const target = s.calendars[0]
			if (!target) throw new Error('caldav: no calendar available to create event')
			const uid = `${crypto.randomUUID()}@frieren`
			const allDay = input.dtstart.length === 10
			const dtend = allDay
				? addDaysAllDay(input.dtstart, 1)
				: addMinutesIso(input.dtstart, input.durationMinutes ?? 60)
			const ics = generateIcs({
				uid,
				summary: input.summary,
				dtstart: input.dtstart,
				dtend,
				...(input.description ? { description: input.description } : {}),
				...(input.location ? { location: input.location } : {})
			})
			const url = `${target.replace(/\/$/, '')}/${encodeURIComponent(uid)}.ics`
			const res = await send('PUT', url, {
				headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' },
				body: ics
			})
			if (!res.ok) throw new Error(describeStatus(res.status, 'create'))
			return { uid }
		},

		async deleteEvent(uid) {
			const found = await findByUid(uid)
			if (!found) throw new Error(`caldav: event ${uid} not found`)
			const res = await send('DELETE', found.href)
			if (!res.ok) throw new Error(describeStatus(res.status, 'delete'))
		}
	}
}
