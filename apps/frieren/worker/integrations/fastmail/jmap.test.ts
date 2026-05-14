import { describe, expect, test } from 'vitest'
import { createJmapClient } from './jmap.ts'

interface Call {
	url: string
	init?: RequestInit
}

function mockFetch(responses: Array<(call: Call) => Response>): {
	fetch: typeof globalThis.fetch
	calls: Call[]
} {
	const calls: Call[] = []
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString()
		const call: Call = { url, init }
		calls.push(call)
		const handler = responses[calls.length - 1]
		if (!handler) throw new Error(`unexpected fetch call ${calls.length}: ${url}`)
		return handler(call)
	}) as typeof globalThis.fetch
	return { fetch, calls }
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
	})
}

const SESSION = {
	apiUrl: 'https://api.fastmail.com/jmap/api/',
	primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc1' },
	accounts: { acc1: { name: 'me@example.com' } }
}

describe('jmap client', () => {
	test('list fetches inbox emails sorted by receivedAt desc', async () => {
		const { fetch, calls } = mockFetch([
			() => jsonResponse(SESSION),
			() =>
				jsonResponse({
					methodResponses: [
						[
							'Mailbox/get',
							{
								list: [
									{ id: 'mb-inbox', role: 'inbox', name: 'Inbox' },
									{ id: 'mb-sent', role: 'sent', name: 'Sent' }
								]
							},
							'0'
						]
					]
				}),
			() =>
				jsonResponse({
					methodResponses: [
						['Email/query', { ids: ['e1', 'e2'] }, '0'],
						[
							'Email/get',
							{
								list: [
									{
										id: 'e1',
										subject: 'Hi',
										from: [{ name: 'Bob', email: 'bob@x.com' }],
										receivedAt: '2026-05-04T10:00:00Z',
										preview: 'hello there'
									},
									{
										id: 'e2',
										subject: 'Yo',
										from: [{ name: null, email: 'a@x.com' }],
										receivedAt: '2026-05-03T10:00:00Z',
										preview: 'snip'
									}
								]
							},
							'1'
						]
					]
				})
		])

		const client = createJmapClient({ token: 'tok', fetch })
		const result = await client.list({ limit: 20 })
		expect(result).toEqual([
			{
				id: 'e1',
				subject: 'Hi',
				from: [{ name: 'Bob', email: 'bob@x.com' }],
				receivedAt: '2026-05-04T10:00:00Z',
				preview: 'hello there'
			},
			{
				id: 'e2',
				subject: 'Yo',
				from: [{ name: null, email: 'a@x.com' }],
				receivedAt: '2026-05-03T10:00:00Z',
				preview: 'snip'
			}
		])

		expect(calls[0]?.url).toBe('https://api.fastmail.com/jmap/session')
		expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok')

		const queryBody = JSON.parse(calls[2]?.init?.body as string)
		expect(queryBody.methodCalls[0][0]).toBe('Email/query')
		expect(queryBody.methodCalls[0][1]).toMatchObject({
			accountId: 'acc1',
			filter: { inMailbox: 'mb-inbox' },
			sort: [{ property: 'receivedAt', isAscending: false }],
			limit: 20
		})
		expect(queryBody.methodCalls[1][0]).toBe('Email/get')
		expect(queryBody.methodCalls[1][1]).toMatchObject({
			accountId: 'acc1',
			'#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }
		})
	})

	test('read fetches a single email with body', async () => {
		const { fetch } = mockFetch([
			() => jsonResponse(SESSION),
			() =>
				jsonResponse({
					methodResponses: [
						[
							'Email/get',
							{
								list: [
									{
										id: 'e1',
										subject: 'Subject',
										from: [{ name: null, email: 'a@x.com' }],
										to: [{ name: null, email: 'me@x.com' }],
										receivedAt: '2026-05-04T10:00:00Z',
										preview: 'preview',
										textBody: [{ partId: '1' }],
										bodyValues: { '1': { value: 'hello body' } }
									}
								]
							},
							'0'
						]
					]
				})
		])

		const client = createJmapClient({ token: 'tok', fetch })
		const email = await client.read('e1')
		expect(email).toMatchObject({
			id: 'e1',
			subject: 'Subject',
			from: [{ email: 'a@x.com' }],
			to: [{ email: 'me@x.com' }],
			text: 'hello body'
		})
	})

	test('read on missing email throws', async () => {
		const { fetch } = mockFetch([
			() => jsonResponse(SESSION),
			() => jsonResponse({ methodResponses: [['Email/get', { list: [] }, '0']] })
		])
		const client = createJmapClient({ token: 'tok', fetch })
		await expect(client.read('nope')).rejects.toThrow(/not found/)
	})

	test('send creates a draft + submission with correct body', async () => {
		const { fetch, calls } = mockFetch([
			() => jsonResponse(SESSION),
			() =>
				jsonResponse({
					methodResponses: [
						['Identity/get', { list: [{ id: 'id1', email: 'me@example.com' }] }, '0'],
						[
							'Mailbox/get',
							{
								list: [
									{ id: 'mb-drafts', role: 'drafts', name: 'Drafts' },
									{ id: 'mb-sent', role: 'sent', name: 'Sent' }
								]
							},
							'1'
						]
					]
				}),
			() =>
				jsonResponse({
					methodResponses: [
						['Email/set', { created: { draft: { id: 'email-1' } } }, '0'],
						['EmailSubmission/set', { created: { sub: { id: 'sub-1' } } }, '1']
					]
				})
		])

		const client = createJmapClient({ token: 'tok', fetch })
		const result = await client.send({ to: 'bob@x.com', subject: 'hi', body: 'hey' })
		expect(result).toEqual({ id: 'email-1' })

		const sendBody = JSON.parse(calls[2]?.init?.body as string)
		const emailSet = sendBody.methodCalls[0]
		expect(emailSet[0]).toBe('Email/set')
		expect(emailSet[1].create.draft).toMatchObject({
			mailboxIds: { 'mb-drafts': true },
			keywords: { $draft: true },
			from: [{ email: 'me@example.com' }],
			to: [{ email: 'bob@x.com' }],
			subject: 'hi',
			bodyStructure: { type: 'text/plain', partId: '0' },
			bodyValues: { '0': { value: 'hey' } }
		})

		const submissionSet = sendBody.methodCalls[1]
		expect(submissionSet[0]).toBe('EmailSubmission/set')
		expect(submissionSet[1].create.sub).toEqual({ emailId: '#draft', identityId: 'id1' })
		expect(submissionSet[1].onSuccessUpdateEmail).toEqual({
			'#sub': {
				'mailboxIds/mb-drafts': null,
				'mailboxIds/mb-sent': true,
				'keywords/$draft': null
			}
		})
	})

	test('list with unread filters by notKeyword $seen', async () => {
		const { fetch, calls } = mockFetch([
			() => jsonResponse(SESSION),
			() =>
				jsonResponse({
					methodResponses: [
						['Mailbox/get', { list: [{ id: 'mb-inbox', role: 'inbox', name: 'Inbox' }] }, '0']
					]
				}),
			() =>
				jsonResponse({
					methodResponses: [
						['Email/query', { ids: [] }, '0'],
						['Email/get', { list: [] }, '1']
					]
				})
		])

		const client = createJmapClient({ token: 'tok', fetch })
		await client.list({ limit: 10, unread: true })
		const queryBody = JSON.parse(calls[2]?.init?.body as string)
		expect(queryBody.methodCalls[0][1].filter).toEqual({
			conditions: [{ inMailbox: 'mb-inbox' }, { notKeyword: '$seen' }],
			operator: 'AND'
		})
	})

	test('markRead sets $seen keyword via Email/set', async () => {
		const { fetch, calls } = mockFetch([
			() => jsonResponse(SESSION),
			() =>
				jsonResponse({
					methodResponses: [['Email/set', { updated: { e1: null } }, '0']]
				})
		])

		const client = createJmapClient({ token: 'tok', fetch })
		await client.markRead('e1')
		const body = JSON.parse(calls[1]?.init?.body as string)
		expect(body.methodCalls[0][0]).toBe('Email/set')
		expect(body.methodCalls[0][1]).toMatchObject({
			accountId: 'acc1',
			update: { e1: { 'keywords/$seen': true } }
		})
	})

	test('markRead throws when notUpdated', async () => {
		const { fetch } = mockFetch([
			() => jsonResponse(SESSION),
			() =>
				jsonResponse({
					methodResponses: [['Email/set', { notUpdated: { e1: { type: 'notFound' } } }, '0']]
				})
		])
		const client = createJmapClient({ token: 'tok', fetch })
		await expect(client.markRead('e1')).rejects.toThrow(/notFound/)
	})

	test('http error surfaces as thrown error', async () => {
		const { fetch } = mockFetch([() => new Response('unauthorized', { status: 401 })])
		const client = createJmapClient({ token: 'bad', fetch })
		await expect(client.list({ limit: 10 })).rejects.toThrow(/401/)
	})

	test('session is fetched once and cached', async () => {
		const { fetch, calls } = mockFetch([
			() => jsonResponse(SESSION),
			() =>
				jsonResponse({
					methodResponses: [
						['Mailbox/get', { list: [{ id: 'mb-inbox', role: 'inbox', name: 'Inbox' }] }, '0']
					]
				}),
			() =>
				jsonResponse({
					methodResponses: [
						['Email/query', { ids: [] }, '0'],
						['Email/get', { list: [] }, '1']
					]
				}),
			() =>
				jsonResponse({
					methodResponses: [
						['Mailbox/get', { list: [{ id: 'mb-inbox', role: 'inbox', name: 'Inbox' }] }, '0']
					]
				}),
			() =>
				jsonResponse({
					methodResponses: [
						['Email/query', { ids: [] }, '0'],
						['Email/get', { list: [] }, '1']
					]
				})
		])

		const client = createJmapClient({ token: 'tok', fetch })
		await client.list({ limit: 10 })
		await client.list({ limit: 10 })
		expect(calls.filter((c) => c.url === 'https://api.fastmail.com/jmap/session')).toHaveLength(1)
	})
})
