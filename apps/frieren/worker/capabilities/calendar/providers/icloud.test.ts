import { describe, expect, test } from 'bun:test'
import type { CalDavClient } from '../../../integrations/icloud-calendar/caldav.ts'
import type { CalEvent } from '../../../integrations/icloud-calendar/ical.ts'
import { calendarHost } from '../host.ts'
import { createIcloudCalendarProvider, type IcloudCalendarCredentials } from './icloud.ts'

function fakeClient(events: CalEvent[], capture?: { start?: Date; end?: Date }): CalDavClient {
	return {
		async listEvents() {
			return events
		},
		async listEventsBetween(start, end) {
			if (capture) {
				capture.start = start
				capture.end = end
			}
			return events
		},
		async readEvent() {
			throw new Error('not used')
		},
		async createEvent() {
			throw new Error('not used')
		},
		async deleteEvent() {
			throw new Error('not used')
		}
	}
}

const creds: IcloudCalendarCredentials = {
	username: 'me@example.com',
	password: 'pw',
	accountId: 'icloud-1'
}

function freshProvider(client: CalDavClient) {
	return createIcloudCalendarProvider({ createClient: () => client })
}

describe('iCloud calendar provider — contract shape', () => {
	test('registers with the calendar host using id "icloud" and exposes listToday', () => {
		const provider = freshProvider(fakeClient([]))
		expect(provider.id).toBe('icloud')
		const impl = provider.create(creds)
		expect(typeof impl.listToday).toBe('function')
	})
})

describe('iCloud calendar provider — normalization', () => {
	test('maps CalDAV events into CalendarEvent DTOs (id/title/start/end/location/accountId)', async () => {
		const events: CalEvent[] = [
			{
				uid: 'event-1@frieren',
				summary: 'Standup',
				dtstart: '2026-05-07T22:00:00Z', // 10:00 NZST on 2026-05-08
				dtend: '2026-05-07T22:30:00Z',
				location: 'Room A',
				description: 'Daily',
				href: 'https://caldav.icloud.com/x/event-1.ics'
			}
		]
		const provider = freshProvider(fakeClient(events))
		const impl = provider.create(creds)
		const result = await impl.listToday({
			timezone: 'Pacific/Auckland',
			now: Date.parse('2026-05-08T03:00:00Z') // 15:00 NZST on 2026-05-08
		})
		expect(result).toEqual([
			{
				id: 'event-1@frieren',
				title: 'Standup',
				startsAt: Date.parse('2026-05-07T22:00:00Z'),
				endsAt: Date.parse('2026-05-07T22:30:00Z'),
				location: 'Room A',
				accountId: 'icloud-1'
			}
		])
		expect(result[0]).not.toHaveProperty('description')
		expect(result[0]).not.toHaveProperty('href')
	})

	test('input.accountId overrides credential accountId; missing accountId is omitted', async () => {
		const events: CalEvent[] = [
			{
				uid: 'event-1@frieren',
				summary: 'Standup',
				dtstart: '2026-05-07T22:00:00Z',
				dtend: '2026-05-07T22:30:00Z'
			}
		]
		const overridden = await freshProvider(fakeClient(events))
			.create(creds)
			.listToday({
				timezone: 'Pacific/Auckland',
				accountId: 'override-1',
				now: Date.parse('2026-05-08T03:00:00Z')
			})
		expect(overridden[0]?.accountId).toBe('override-1')

		const noAccount = await freshProvider(fakeClient(events))
			.create({ username: 'me', password: 'pw' })
			.listToday({
				timezone: 'Pacific/Auckland',
				now: Date.parse('2026-05-08T03:00:00Z')
			})
		expect(noAccount[0]).not.toHaveProperty('accountId')
	})

	test('events are returned sorted by startsAt', async () => {
		const events: CalEvent[] = [
			{
				uid: 'b',
				summary: 'Later',
				dtstart: '2026-05-08T01:00:00Z', // 13:00 NZST on 2026-05-08
				dtend: '2026-05-08T02:00:00Z'
			},
			{
				uid: 'a',
				summary: 'Earlier',
				dtstart: '2026-05-07T22:00:00Z', // 10:00 NZST on 2026-05-08
				dtend: '2026-05-07T23:00:00Z'
			}
		]
		const result = await freshProvider(fakeClient(events))
			.create(creds)
			.listToday({
				timezone: 'Pacific/Auckland',
				now: Date.parse('2026-05-08T03:00:00Z')
			})
		expect(result.map((e) => e.id)).toEqual(['a', 'b'])
	})
})

describe('iCloud calendar provider — timezone/day boundaries', () => {
	test('asks CalDAV for the local-day window in the requested timezone', async () => {
		const capture: { start?: Date; end?: Date } = {}
		await freshProvider(fakeClient([], capture))
			.create(creds)
			.listToday({
				timezone: 'Pacific/Auckland', // UTC+12 / UTC+13 (DST aware)
				now: Date.parse('2026-05-08T03:00:00Z') // 15:00 NZST on 2026-05-08
			})
		// 2026-05-08 NZST midnight = 2026-05-07 12:00 UTC; next day = 2026-05-08 12:00 UTC
		expect(capture.start?.toISOString()).toBe('2026-05-07T12:00:00.000Z')
		expect(capture.end?.toISOString()).toBe('2026-05-08T12:00:00.000Z')
	})

	test('drops events that fall outside the local day even if CalDAV returns them', async () => {
		const events: CalEvent[] = [
			{
				uid: 'today',
				summary: 'In-day',
				dtstart: '2026-05-07T22:00:00Z',
				dtend: '2026-05-07T23:00:00Z' // 10:00 NZST on 2026-05-08
			},
			{
				uid: 'yesterday',
				summary: 'Before',
				dtstart: '2026-05-07T11:00:00Z', // 23:00 NZST on 2026-05-07
				dtend: '2026-05-07T11:30:00Z'
			},
			{
				uid: 'tomorrow',
				summary: 'After',
				dtstart: '2026-05-08T12:00:00Z', // 00:00 NZST on 2026-05-09
				dtend: '2026-05-08T13:00:00Z'
			}
		]
		const result = await freshProvider(fakeClient(events))
			.create(creds)
			.listToday({
				timezone: 'Pacific/Auckland',
				now: Date.parse('2026-05-08T03:00:00Z')
			})
		expect(result.map((e) => e.id)).toEqual(['today'])
	})

	test('includes events that start before midnight but end after it (overlap)', async () => {
		const events: CalEvent[] = [
			{
				uid: 'overnight',
				summary: 'Long meeting',
				dtstart: '2026-05-07T11:30:00Z', // 23:30 NZST 2026-05-07
				dtend: '2026-05-07T12:30:00Z' // 00:30 NZST 2026-05-08
			}
		]
		const result = await freshProvider(fakeClient(events))
			.create(creds)
			.listToday({
				timezone: 'Pacific/Auckland',
				now: Date.parse('2026-05-08T03:00:00Z')
			})
		expect(result.map((e) => e.id)).toEqual(['overnight'])
	})

	test('all-day events anchor to midnight in the target timezone', async () => {
		const events: CalEvent[] = [
			{ uid: 'allday', summary: 'Holiday', dtstart: '2026-05-08', dtend: '2026-05-09' }
		]
		const result = await freshProvider(fakeClient(events))
			.create(creds)
			.listToday({
				timezone: 'Pacific/Auckland',
				now: Date.parse('2026-05-08T03:00:00Z')
			})
		expect(result).toHaveLength(1)
		// Midnight NZST on 2026-05-08 == 2026-05-07T12:00:00Z
		expect(result[0]?.startsAt).toBe(Date.parse('2026-05-07T12:00:00Z'))
		expect(result[0]?.endsAt).toBe(Date.parse('2026-05-08T12:00:00Z'))
	})

	test('different timezones produce different day windows for the same `now`', async () => {
		const nyCapture: { start?: Date; end?: Date } = {}
		await freshProvider(fakeClient([], nyCapture))
			.create(creds)
			.listToday({
				timezone: 'America/New_York',
				now: Date.parse('2026-05-08T03:00:00Z') // 23:00 EDT on 2026-05-07
			})
		// In New York the local date is 2026-05-07: midnight = 04:00 UTC
		expect(nyCapture.start?.toISOString()).toBe('2026-05-07T04:00:00.000Z')
		expect(nyCapture.end?.toISOString()).toBe('2026-05-08T04:00:00.000Z')
	})
})

describe('iCloud calendar provider — broker integration', () => {
	test('listToday is reachable through the broker with a matching grant', async () => {
		const events: CalEvent[] = [
			{
				uid: 'e1',
				summary: 'Hi',
				dtstart: '2026-05-07T22:00:00Z',
				dtend: '2026-05-07T22:30:00Z'
			}
		]
		const provider = freshProvider(fakeClient(events))
		const broker = calendarHost.createBroker({
			userId: 'u1',
			grants: [{ capability: 'calendar', scope: 'read.today', accountId: 'icloud-1' }],
			resolveAccount: () => ({ providerId: provider.id, credentials: creds })
		})
		const result = (await broker.invoke({
			capability: 'calendar',
			method: 'listToday',
			input: {
				timezone: 'Pacific/Auckland',
				accountId: 'icloud-1',
				now: Date.parse('2026-05-08T03:00:00Z')
			}
		})) as Array<{ id: string }>
		expect(result.map((e) => e.id)).toEqual(['e1'])
	})

	test('broker normalizes provider failures into CAPABILITY_FAILED', async () => {
		const failingClient: CalDavClient = {
			...fakeClient([]),
			async listEventsBetween() {
				throw new Error('caldav unavailable')
			}
		}
		const provider = freshProvider(failingClient)
		const broker = calendarHost.createBroker({
			userId: 'u1',
			grants: [{ capability: 'calendar', scope: 'read.today' }],
			resolveAccount: () => ({ providerId: provider.id, credentials: creds })
		})
		await expect(
			broker.invoke({
				capability: 'calendar',
				method: 'listToday',
				input: { timezone: 'Pacific/Auckland', now: Date.parse('2026-05-08T03:00:00Z') }
			})
		).rejects.toMatchObject({
			code: 'CAPABILITY_FAILED',
			capability: 'calendar',
			method: 'listToday',
			message: 'caldav unavailable'
		})
	})

	test('broker denies listToday without the read.today grant', async () => {
		const provider = freshProvider(fakeClient([]))
		const broker = calendarHost.createBroker({
			userId: 'u1',
			grants: [],
			resolveAccount: () => ({ providerId: provider.id, credentials: creds })
		})
		await expect(
			broker.invoke({
				capability: 'calendar',
				method: 'listToday',
				input: { timezone: 'Pacific/Auckland' }
			})
		).rejects.toMatchObject({
			code: 'CAPABILITY_DENIED',
			capability: 'calendar',
			method: 'listToday'
		})
	})
})
