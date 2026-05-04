import { describe, expect, test } from 'bun:test'
import type { Volume } from '@justfiles/fs'
import type { CalDavClient, CreateEventInput } from './caldav.ts'
import { createIcloudCalendarCommand } from './commands.ts'
import type { CalEvent } from './ical.ts'

interface Recorded {
	listed: Array<{ days?: number } | undefined>
	read: string[]
	created: CreateEventInput[]
	deleted: string[]
}

function fakeClient(overrides: Partial<CalDavClient> = {}): {
	client: CalDavClient
	rec: Recorded
} {
	const rec: Recorded = { listed: [], read: [], created: [], deleted: [] }
	const client: CalDavClient = {
		async listEvents(opts) {
			rec.listed.push(opts)
			return overrides.listEvents ? overrides.listEvents(opts) : []
		},
		async readEvent(uid) {
			rec.read.push(uid)
			if (overrides.readEvent) return overrides.readEvent(uid)
			throw new Error('no readEvent override')
		},
		async createEvent(input) {
			rec.created.push(input)
			return overrides.createEvent ? overrides.createEvent(input) : { uid: 'new-uid@frieren' }
		},
		async deleteEvent(uid) {
			rec.deleted.push(uid)
			if (overrides.deleteEvent) return overrides.deleteEvent(uid)
		}
	}
	return { client, rec }
}

const ctx = { vol: undefined as unknown as Volume }

const SAMPLE_EVENT: CalEvent = {
	uid: 'event-1@frieren',
	summary: 'Standup',
	dtstart: '2026-05-10T10:00:00Z',
	dtend: '2026-05-10T10:30:00Z',
	location: 'Room A',
	description: 'Daily sync'
}

describe('icloud-calendar command', () => {
	test('with no args prints help with all subcommands', async () => {
		const { client } = fakeClient()
		const cmd = createIcloudCalendarCommand(client)
		const res = await cmd.run([], ctx)
		expect(res.exitCode).toBe(0)
		for (const sub of ['list', 'read', 'create', 'delete']) {
			expect(res.stdout).toContain(sub)
		}
	})

	test('list with default days returns tab-separated rows', async () => {
		const { client, rec } = fakeClient({
			async listEvents() {
				return [SAMPLE_EVENT]
			}
		})
		const cmd = createIcloudCalendarCommand(client)
		const res = await cmd.run(['list'], ctx)
		expect(res.exitCode).toBe(0)
		expect(rec.listed).toEqual([{ days: 7 }])
		expect(res.stdout).toBe('event-1@frieren\t2026-05-10T10:00:00Z\tStandup')
	})

	test('list --days forwards the count', async () => {
		const { client, rec } = fakeClient({
			async listEvents() {
				return []
			}
		})
		const cmd = createIcloudCalendarCommand(client)
		await cmd.run(['list', '--days', '14'], ctx)
		expect(rec.listed).toEqual([{ days: 14 }])
	})

	test('list --days with a non-positive value is a usage error', async () => {
		const { client } = fakeClient()
		const cmd = createIcloudCalendarCommand(client)
		const res = await cmd.run(['list', '--days', '0'], ctx)
		expect(res.exitCode).toBe(2)
		expect(res.stderr).toContain('positive')
	})

	test('read prints UID, summary, start, end, location, description', async () => {
		const { client, rec } = fakeClient({
			async readEvent() {
				return SAMPLE_EVENT
			}
		})
		const cmd = createIcloudCalendarCommand(client)
		const res = await cmd.run(['read', 'event-1@frieren'], ctx)
		expect(res.exitCode).toBe(0)
		expect(rec.read).toEqual(['event-1@frieren'])
		for (const fragment of [
			'UID: event-1@frieren',
			'Summary: Standup',
			'Start: 2026-05-10T10:00:00Z',
			'End: 2026-05-10T10:30:00Z',
			'Location: Room A',
			'Description: Daily sync'
		]) {
			expect(res.stdout).toContain(fragment)
		}
	})

	test('read without uid is a usage error', async () => {
		const { client } = fakeClient()
		const cmd = createIcloudCalendarCommand(client)
		const res = await cmd.run(['read'], ctx)
		expect(res.exitCode).toBe(2)
		expect(res.stderr).toContain('uid')
	})

	test('create parses key:value args and returns the new uid', async () => {
		const { client, rec } = fakeClient()
		const cmd = createIcloudCalendarCommand(client)
		const res = await cmd.run(
			['create', 'date:2026-06-15T15:00:00Z', 'title:Dentist', 'duration:30'],
			ctx
		)
		expect(res.exitCode).toBe(0)
		expect(rec.created).toEqual([
			{ dtstart: '2026-06-15T15:00:00Z', summary: 'Dentist', durationMinutes: 30 }
		])
		expect(res.stdout).toBe('new-uid@frieren')
	})

	test('create without duration omits durationMinutes', async () => {
		const { client, rec } = fakeClient()
		const cmd = createIcloudCalendarCommand(client)
		await cmd.run(['create', 'date:2026-06-15T15:00:00Z', 'title:Dentist'], ctx)
		expect(rec.created).toEqual([{ dtstart: '2026-06-15T15:00:00Z', summary: 'Dentist' }])
	})

	test('create with a missing required field is a usage error', async () => {
		const { client } = fakeClient()
		const cmd = createIcloudCalendarCommand(client)
		const res = await cmd.run(['create', 'date:2026-06-15T15:00:00Z'], ctx)
		expect(res.exitCode).toBe(2)
		expect(res.stderr).toContain('title')
	})

	test('delete forwards the uid and confirms', async () => {
		const { client, rec } = fakeClient()
		const cmd = createIcloudCalendarCommand(client)
		const res = await cmd.run(['delete', 'event-1@frieren'], ctx)
		expect(res.exitCode).toBe(0)
		expect(rec.deleted).toEqual(['event-1@frieren'])
		expect(res.stdout).toContain('event-1@frieren')
	})

	test('delete without uid is a usage error', async () => {
		const { client } = fakeClient()
		const cmd = createIcloudCalendarCommand(client)
		const res = await cmd.run(['delete'], ctx)
		expect(res.exitCode).toBe(2)
		expect(res.stderr).toContain('uid')
	})

	test('unknown subcommand fails with help', async () => {
		const { client } = fakeClient()
		const cmd = createIcloudCalendarCommand(client)
		const res = await cmd.run(['nope'], ctx)
		expect(res.exitCode).toBe(2)
		expect(res.stderr).toContain('nope')
		expect(res.stderr).toContain('Subcommands')
	})

	test('client errors map to exit 1 with stderr', async () => {
		const { client } = fakeClient({
			async listEvents() {
				throw new Error('401 boom')
			}
		})
		const cmd = createIcloudCalendarCommand(client)
		const res = await cmd.run(['list'], ctx)
		expect(res.exitCode).toBe(1)
		expect(res.stderr).toContain('401')
	})
})
