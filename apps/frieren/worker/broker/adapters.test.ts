import { describe, expect, test } from 'bun:test'
import { volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import type { EmailDetails, EmailSummary, JmapClient } from '../integrations/fastmail/jmap.ts'
import type { CalDavClient } from '../integrations/icloud-calendar/caldav.ts'
import type { CalEvent } from '../integrations/icloud-calendar/ical.ts'
import { fastmailEmailAdapter, icloudCalendarAdapter, volumeAdapter } from './adapters.ts'

function fakeJmap(summaries: EmailSummary[], detail?: EmailDetails): JmapClient {
	return {
		async list() {
			return summaries
		},
		async read() {
			if (!detail) throw new Error('no detail')
			return detail
		},
		async send() {
			return { id: 'x' }
		},
		async markRead() {}
	}
}

function fakeCalDav(events: CalEvent[]): CalDavClient {
	return {
		async listEvents() {
			return events
		},
		async readEvent(uid) {
			const found = events.find((e) => e.uid === uid)
			if (!found) throw new Error('missing')
			return found
		},
		async createEvent() {
			return { uid: 'new' }
		},
		async deleteEvent() {}
	}
}

describe('fastmailEmailAdapter', () => {
	test('normalizes JMAP summaries into EmailDTOs', async () => {
		const summaries: EmailSummary[] = [
			{
				id: 'm1',
				subject: 'Hi',
				from: [{ name: 'Alice', email: 'alice@example.com' }],
				receivedAt: '2025-12-01T10:00:00Z',
				preview: 'hello there'
			}
		]
		const adapter = fastmailEmailAdapter('work', fakeJmap(summaries))
		const dtos = await adapter.listUnread({ limit: 10 })
		expect(dtos).toEqual([
			{
				id: 'm1',
				accountId: 'work',
				source: 'fastmail',
				from: { name: 'Alice', email: 'alice@example.com' },
				subject: 'Hi',
				receivedAt: Date.parse('2025-12-01T10:00:00Z'),
				preview: 'hello there'
			}
		])
	})

	test('since filter drops older messages', async () => {
		const summaries: EmailSummary[] = [
			{
				id: 'old',
				subject: 'old',
				from: [{ name: null, email: 'a@a' }],
				receivedAt: '2025-01-01T00:00:00Z',
				preview: ''
			},
			{
				id: 'new',
				subject: 'new',
				from: [{ name: null, email: 'b@b' }],
				receivedAt: '2025-12-01T00:00:00Z',
				preview: ''
			}
		]
		const adapter = fastmailEmailAdapter('work', fakeJmap(summaries))
		const result = await adapter.listUnread({ since: Date.parse('2025-06-01T00:00:00Z') })
		expect(result.map((d) => d.id)).toEqual(['new'])
	})

	test('readDetail includes text body', async () => {
		const detail: EmailDetails = {
			id: 'm1',
			subject: 'Hi',
			from: [{ name: 'Alice', email: 'alice@example.com' }],
			to: [{ name: null, email: 'me@example.com' }],
			receivedAt: '2025-12-01T10:00:00Z',
			preview: 'hello',
			text: 'hello there friend'
		}
		const adapter = fastmailEmailAdapter('work', fakeJmap([], detail))
		const dto = await adapter.readDetail({ id: 'm1' })
		expect(dto.text).toBe('hello there friend')
		expect(dto.to).toEqual([{ name: undefined, email: 'me@example.com' }])
	})
})

describe('icloudCalendarAdapter', () => {
	test('returns events overlapping today in the requested timezone', async () => {
		const events: CalEvent[] = [
			{
				uid: 'today',
				summary: 'Standup',
				dtstart: '2025-12-01T15:00:00Z',
				dtend: '2025-12-01T15:30:00Z'
			},
			{
				uid: 'tomorrow',
				summary: 'Future',
				dtstart: '2025-12-03T15:00:00Z',
				dtend: '2025-12-03T15:30:00Z'
			}
		]
		const adapter = icloudCalendarAdapter('me', fakeCalDav(events))
		const result = await adapter.listToday({
			timezone: 'UTC',
			now: Date.parse('2025-12-01T12:00:00Z')
		})
		expect(result.map((e) => e.id)).toEqual(['today'])
		expect(result[0]).toMatchObject({
			accountId: 'me',
			source: 'icloud-calendar',
			title: 'Standup'
		})
	})
})

describe('volumeAdapter', () => {
	test('round-trips bytes through the underlying volume', async () => {
		const vol = volume(memStorage())
		const adapter = volumeAdapter(vol)
		await adapter.writeFile({ path: '/x.bin', data: new Uint8Array([1, 2, 3]) })
		const read = await adapter.readFile({ path: '/x.bin' })
		expect(read).toEqual(new Uint8Array([1, 2, 3]))
	})

	test('root scope prepends to all paths', async () => {
		const calls: Array<{ path: string }> = []
		const fakeVol = {
			async readFile(path: string) {
				calls.push({ path })
				return new Uint8Array()
			},
			async writeFile(path: string) {
				calls.push({ path })
			}
		} as unknown as import('@justfiles/fs').Volume
		const adapter = volumeAdapter(fakeVol, '/apps/today')
		await adapter.writeFile({ path: 'state.json', data: new Uint8Array([42]) })
		await adapter.readFile({ path: '/inner.json' })
		expect(calls.map((c) => c.path)).toEqual(['/apps/today/state.json', '/apps/today/inner.json'])
	})
})
