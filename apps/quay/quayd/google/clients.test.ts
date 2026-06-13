import { describe, expect, test } from 'vitest'
import { createGoogleCalendar } from './calendar.ts'
import { createGmailEmail } from './gmail.ts'
import type { AuthedFetch } from './oauth.ts'

// A canned AuthedFetch: route by path to a JSON body, recording every call so a
// test can assert what the client requested (query, method, body). No network.
function fakeFetch(routes: Record<string, unknown>): {
	fetch: AuthedFetch
	calls: { path: string; method?: string; body?: string }[]
} {
	const calls: { path: string; method?: string; body?: string }[] = []
	const fetch: AuthedFetch = async (path, init = {}) => {
		calls.push({ path, method: init.method, body: init.body })
		const key = Object.keys(routes).find((r) => path.includes(r))
		return new Response(JSON.stringify(key ? routes[key] : {}), {
			headers: { 'content-type': 'application/json' }
		})
	}
	return { fetch, calls }
}

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url')

describe('gmail client', () => {
	test('listUnread queries unread then summarizes per-message metadata', async () => {
		const { fetch, calls } = fakeFetch({
			'/messages?q=is:unread': { messages: [{ id: 'm1' }, { id: 'm2' }] },
			'/messages/m1': {
				id: 'm1',
				internalDate: '1700000000000',
				labelIds: ['UNREAD', 'INBOX'],
				payload: {
					headers: [
						{ name: 'From', value: 'Ada <ada@example.com>' },
						{ name: 'Subject', value: 'Hello' }
					]
				}
			},
			'/messages/m2': {
				id: 'm2',
				internalDate: '1700000001000',
				labelIds: ['UNREAD'],
				payload: { headers: [{ name: 'Subject', value: 'Hi' }] }
			}
		})
		const summaries = await createGmailEmail(fetch).listUnread({})
		expect(summaries).toEqual([
			{
				id: 'm1',
				from: 'Ada <ada@example.com>',
				subject: 'Hello',
				receivedAt: 1700000000000,
				unread: true
			},
			{ id: 'm2', from: '', subject: 'Hi', receivedAt: 1700000001000, unread: true }
		])
		// The list call carried the default cap, and metadata was requested per id.
		expect(calls[0].path).toContain('maxResults=20')
		expect(calls[1].path).toContain('format=metadata')
	})

	test('readDetail extracts the nested text/plain body', async () => {
		const { fetch } = fakeFetch({
			'/messages/m1': {
				id: 'm1',
				internalDate: '1700000000000',
				labelIds: [],
				payload: {
					mimeType: 'multipart/alternative',
					headers: [{ name: 'Subject', value: 'Doc' }],
					parts: [
						{ mimeType: 'text/html', body: { data: b64url('<p>nope</p>') } },
						{ mimeType: 'text/plain', body: { data: b64url('the body') } }
					]
				}
			}
		})
		const detail = await createGmailEmail(fetch).readDetail({ id: 'm1', purpose: 'summarization' })
		expect(detail.subject).toBe('Doc')
		expect(detail.unread).toBe(false) // no UNREAD label
		expect(detail.bodyText).toBe('the body')
	})

	test('markRead POSTs a removeLabelIds modify', async () => {
		const { fetch, calls } = fakeFetch({ '/modify': {} })
		await expect(createGmailEmail(fetch).markRead({ id: 'm9' })).resolves.toEqual({ success: true })
		expect(calls[0]).toMatchObject({
			path: expect.stringContaining('/messages/m9/modify'),
			method: 'POST'
		})
		expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ removeLabelIds: ['UNREAD'] })
	})
})

describe('google calendar client', () => {
	test('listToday windows the request and normalizes timed + all-day events', async () => {
		const { fetch, calls } = fakeFetch({
			'/events': {
				items: [
					{
						id: 'e1',
						summary: 'Standup',
						location: 'Room 1',
						start: { dateTime: '2026-06-14T09:00:00Z' },
						end: { dateTime: '2026-06-14T09:30:00Z' }
					},
					{ id: 'e2', start: { date: '2026-06-14' }, end: { date: '2026-06-15' } },
					{ id: 'e3', summary: 'broken' } // no start/end → dropped
				]
			}
		})
		const events = await createGoogleCalendar(fetch).listToday({
			timezone: 'UTC',
			now: Date.parse('2026-06-14T12:00:00Z')
		})
		expect(events).toEqual([
			{
				id: 'e1',
				title: 'Standup',
				location: 'Room 1',
				startsAt: Date.parse('2026-06-14T09:00:00Z'),
				endsAt: Date.parse('2026-06-14T09:30:00Z')
			},
			{
				id: 'e2',
				title: '(no title)',
				startsAt: Date.parse('2026-06-14T00:00:00Z'),
				endsAt: Date.parse('2026-06-15T00:00:00Z')
			}
		])
		// Today's UTC window was sent; recurrences expanded.
		expect(calls[0].path).toContain('timeMin=2026-06-14T00%3A00%3A00.000Z')
		expect(calls[0].path).toContain('timeMax=2026-06-15T00%3A00%3A00.000Z')
		expect(calls[0].path).toContain('singleEvents=true')
	})
})
