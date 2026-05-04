import { describe, expect, test } from 'bun:test'
import { createCalDavClient } from './caldav.ts'

interface Call {
	url: string
	method: string
	init?: RequestInit
}

function mockFetch(responses: Array<(call: Call) => Response>): {
	fetch: typeof globalThis.fetch
	calls: Call[]
} {
	const calls: Call[] = []
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString()
		const method = (init?.method ?? 'GET').toUpperCase()
		const call: Call = { url, method, init }
		calls.push(call)
		const handler = responses[calls.length - 1]
		if (!handler) throw new Error(`unexpected fetch call ${calls.length}: ${method} ${url}`)
		return handler(call)
	}) as typeof globalThis.fetch
	return { fetch, calls }
}

function xmlResponse(body: string, status = 207): Response {
	return new Response(body, {
		status,
		headers: { 'Content-Type': 'application/xml; charset=utf-8' }
	})
}

const PRINCIPAL_RESPONSE = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
	<D:response>
		<D:href>/</D:href>
		<D:propstat>
			<D:prop>
				<D:current-user-principal>
					<D:href>/123456789/principal/</D:href>
				</D:current-user-principal>
			</D:prop>
			<D:status>HTTP/1.1 200 OK</D:status>
		</D:propstat>
	</D:response>
</D:multistatus>`

const HOME_RESPONSE = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
	<D:response>
		<D:href>/123456789/principal/</D:href>
		<D:propstat>
			<D:prop>
				<C:calendar-home-set>
					<D:href>/123456789/calendars/</D:href>
				</C:calendar-home-set>
			</D:prop>
			<D:status>HTTP/1.1 200 OK</D:status>
		</D:propstat>
	</D:response>
</D:multistatus>`

const CALENDARS_RESPONSE = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
	<D:response>
		<D:href>/123456789/calendars/</D:href>
		<D:propstat>
			<D:prop>
				<D:resourcetype><D:collection/></D:resourcetype>
			</D:prop>
			<D:status>HTTP/1.1 200 OK</D:status>
		</D:propstat>
	</D:response>
	<D:response>
		<D:href>/123456789/calendars/work/</D:href>
		<D:propstat>
			<D:prop>
				<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
				<C:supported-calendar-component-set>
					<C:comp name="VEVENT"/>
				</C:supported-calendar-component-set>
			</D:prop>
			<D:status>HTTP/1.1 200 OK</D:status>
		</D:propstat>
	</D:response>
	<D:response>
		<D:href>/123456789/calendars/tasks/</D:href>
		<D:propstat>
			<D:prop>
				<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
				<C:supported-calendar-component-set>
					<C:comp name="VTODO"/>
				</C:supported-calendar-component-set>
			</D:prop>
			<D:status>HTTP/1.1 200 OK</D:status>
		</D:propstat>
	</D:response>
</D:multistatus>`

function eventReportResponse(href: string, ics: string): string {
	return `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
	<D:response>
		<D:href>${href}</D:href>
		<D:propstat>
			<D:prop>
				<D:getetag>"abc"</D:getetag>
				<C:calendar-data>${ics}</C:calendar-data>
			</D:prop>
			<D:status>HTTP/1.1 200 OK</D:status>
		</D:propstat>
	</D:response>
</D:multistatus>`
}

const SAMPLE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:event-1@frieren
SUMMARY:Standup
DTSTART:20260510T100000Z
DTEND:20260510T103000Z
END:VEVENT
END:VCALENDAR`

describe('caldav client', () => {
	test('discovery chain runs principal → home → calendars and skips non-VEVENT collections', async () => {
		const { fetch, calls } = mockFetch([
			() => xmlResponse(PRINCIPAL_RESPONSE),
			() => xmlResponse(HOME_RESPONSE),
			() => xmlResponse(CALENDARS_RESPONSE),
			() => xmlResponse(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"></D:multistatus>`)
		])

		const client = createCalDavClient({ username: 'me@example.com', password: 'pw', fetch })
		await client.listEvents()

		expect(calls[0]).toMatchObject({
			url: 'https://caldav.icloud.com/',
			method: 'PROPFIND'
		})
		expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toMatch(/^Basic /)

		expect(calls[1]).toMatchObject({
			url: 'https://caldav.icloud.com/123456789/principal/',
			method: 'PROPFIND'
		})
		expect(calls[2]).toMatchObject({
			url: 'https://caldav.icloud.com/123456789/calendars/',
			method: 'PROPFIND'
		})
		expect(calls[3]).toMatchObject({
			url: 'https://caldav.icloud.com/123456789/calendars/work/',
			method: 'REPORT'
		})
		expect(calls).toHaveLength(4)
	})

	test('listEvents sends time-range REPORT and parses returned ICS', async () => {
		const { fetch, calls } = mockFetch([
			() => xmlResponse(PRINCIPAL_RESPONSE),
			() => xmlResponse(HOME_RESPONSE),
			() => xmlResponse(CALENDARS_RESPONSE),
			() => xmlResponse(eventReportResponse('/123456789/calendars/work/event-1.ics', SAMPLE_ICS))
		])

		const client = createCalDavClient({ username: 'me@example.com', password: 'pw', fetch })
		const events = await client.listEvents({ days: 14 })
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			uid: 'event-1@frieren',
			summary: 'Standup',
			dtstart: '2026-05-10T10:00:00Z',
			dtend: '2026-05-10T10:30:00Z',
			href: 'https://caldav.icloud.com/123456789/calendars/work/event-1.ics'
		})

		const reportBody = calls[3]?.init?.body as string
		expect(reportBody).toContain('<C:calendar-query')
		expect(reportBody).toContain('<C:time-range')
		expect(reportBody).toMatch(/start="\d{8}T\d{6}Z"/)
		expect(reportBody).toMatch(/end="\d{8}T\d{6}Z"/)
		expect((calls[3]?.init?.headers as Record<string, string>)['Content-Type']).toContain(
			'application/xml'
		)
	})

	test('createEvent PUTs ICS to the first VEVENT-capable calendar and returns the new uid', async () => {
		const { fetch, calls } = mockFetch([
			() => xmlResponse(PRINCIPAL_RESPONSE),
			() => xmlResponse(HOME_RESPONSE),
			() => xmlResponse(CALENDARS_RESPONSE),
			() => new Response(null, { status: 201 })
		])

		const client = createCalDavClient({ username: 'me@example.com', password: 'pw', fetch })
		const { uid } = await client.createEvent({
			summary: 'Dentist',
			dtstart: '2026-06-15T15:00:00Z',
			durationMinutes: 30
		})
		expect(uid).toMatch(/@frieren$/)

		const put = calls[3]
		expect(put?.method).toBe('PUT')
		expect(put?.url.startsWith('https://caldav.icloud.com/123456789/calendars/work/')).toBe(true)
		expect(put?.url.endsWith(`${encodeURIComponent(uid)}.ics`)).toBe(true)
		const body = put?.init?.body as string
		expect(body).toContain('BEGIN:VCALENDAR')
		expect(body).toContain(`UID:${uid}`)
		expect(body).toContain('SUMMARY:Dentist')
		expect(body).toContain('DTSTART:20260615T150000Z')
		expect(body).toContain('DTEND:20260615T153000Z')
	})

	test('deleteEvent finds the event by uid then issues DELETE on its href', async () => {
		const { fetch, calls } = mockFetch([
			() => xmlResponse(PRINCIPAL_RESPONSE),
			() => xmlResponse(HOME_RESPONSE),
			() => xmlResponse(CALENDARS_RESPONSE),
			() => xmlResponse(eventReportResponse('/123456789/calendars/work/event-1.ics', SAMPLE_ICS)),
			() => new Response(null, { status: 204 })
		])

		const client = createCalDavClient({ username: 'me@example.com', password: 'pw', fetch })
		await client.deleteEvent('event-1@frieren')

		const del = calls[4]
		expect(del?.method).toBe('DELETE')
		expect(del?.url).toBe('https://caldav.icloud.com/123456789/calendars/work/event-1.ics')
	})

	test('a 401 response surfaces the app-specific-password hint', async () => {
		const { fetch } = mockFetch([() => new Response('unauthorized', { status: 401 })])
		const client = createCalDavClient({ username: 'me@example.com', password: 'wrong', fetch })
		await expect(client.listEvents()).rejects.toThrow(/app-specific password/i)
	})
})
