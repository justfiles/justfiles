import { describe, expect, test } from 'bun:test'
import { defineProviderBackedCapability } from '@justfiles/app/capabilities/broker'
import { type EmailCapability, email } from '@justfiles/app/capabilities/email'
import type { EmailDetails, EmailSummary, JmapClient, SendInput } from './jmap.ts'
import {
	buildFastmailEmailCapability,
	createFastmailEmailProvider,
	FASTMAIL_PROVIDER_ID,
	formatFrom,
	normalizeEmailDetail,
	normalizeEmailSummary
} from './provider.ts'

interface FakeJmapState {
	list?: (options: { limit: number; unread?: boolean }) => Promise<EmailSummary[]>
	read?: (id: string) => Promise<EmailDetails>
	markRead?: (id: string) => Promise<void>
	send?: (input: SendInput) => Promise<{ id: string }>
}

function fakeJmapClient(state: FakeJmapState): JmapClient {
	return {
		async list(options) {
			if (!state.list) throw new Error('list not stubbed')
			return state.list(options)
		},
		async read(id) {
			if (!state.read) throw new Error('read not stubbed')
			return state.read(id)
		},
		async markRead(id) {
			if (!state.markRead) throw new Error('markRead not stubbed')
			return state.markRead(id)
		},
		async send(input) {
			if (!state.send) throw new Error('send not stubbed')
			return state.send(input)
		}
	}
}

describe('formatFrom', () => {
	test('renders name and email when name is present', () => {
		expect(formatFrom([{ name: 'Bob', email: 'bob@x.com' }])).toBe('Bob <bob@x.com>')
	})

	test('renders email only when name is null or blank', () => {
		expect(formatFrom([{ name: null, email: 'a@x.com' }])).toBe('a@x.com')
		expect(formatFrom([{ name: '   ', email: 'a@x.com' }])).toBe('a@x.com')
	})

	test('returns empty string for missing or empty addresses', () => {
		expect(formatFrom(undefined)).toBe('')
		expect(formatFrom([])).toBe('')
	})
})

describe('normalizeEmailSummary', () => {
	test('maps JMAP summary to EmailSummary with unread=true', () => {
		const summary = normalizeEmailSummary({
			id: 'e1',
			subject: 'Hi',
			from: [{ name: 'Bob', email: 'bob@x.com' }],
			receivedAt: '2026-05-04T10:00:00Z',
			preview: 'hello'
		})
		expect(summary).toEqual({
			id: 'e1',
			from: 'Bob <bob@x.com>',
			subject: 'Hi',
			receivedAt: Date.parse('2026-05-04T10:00:00Z'),
			unread: true
		})
	})

	test('handles missing subject', () => {
		const summary = normalizeEmailSummary({
			id: 'e2',
			subject: null,
			from: [{ name: null, email: 'a@x.com' }],
			receivedAt: '2026-05-03T10:00:00Z',
			preview: ''
		})
		expect(summary.subject).toBe('')
		expect(summary.from).toBe('a@x.com')
	})
})

describe('normalizeEmailDetail', () => {
	test('maps JMAP details to EmailDetail with bodyText', () => {
		const detail = normalizeEmailDetail({
			id: 'e1',
			subject: 'Subject',
			from: [{ name: null, email: 'a@x.com' }],
			to: [{ name: null, email: 'me@x.com' }],
			receivedAt: '2026-05-04T10:00:00Z',
			preview: 'preview',
			text: 'hello body'
		})
		expect(detail).toEqual({
			id: 'e1',
			from: 'a@x.com',
			subject: 'Subject',
			receivedAt: Date.parse('2026-05-04T10:00:00Z'),
			unread: false,
			bodyText: 'hello body'
		})
	})
})

describe('buildFastmailEmailCapability', () => {
	test('listUnread requests unread filter and normalizes results', async () => {
		const seenOptions: Array<{ limit: number; unread?: boolean }> = []
		const cap = buildFastmailEmailCapability(
			fakeJmapClient({
				async list(options) {
					seenOptions.push(options)
					return [
						{
							id: 'e1',
							subject: 'Hi',
							from: [{ name: 'Bob', email: 'bob@x.com' }],
							receivedAt: '2026-05-04T10:00:00Z',
							preview: 'hello'
						}
					]
				}
			})
		)
		const result = await cap.listUnread({ limit: 5 })
		expect(seenOptions).toEqual([{ limit: 5, unread: true }])
		expect(result).toEqual([
			{
				id: 'e1',
				from: 'Bob <bob@x.com>',
				subject: 'Hi',
				receivedAt: Date.parse('2026-05-04T10:00:00Z'),
				unread: true
			}
		])
	})

	test('listUnread defaults limit to 20', async () => {
		let seenLimit = -1
		const cap = buildFastmailEmailCapability(
			fakeJmapClient({
				async list(options) {
					seenLimit = options.limit
					return []
				}
			})
		)
		await cap.listUnread({})
		expect(seenLimit).toBe(20)
	})

	test('readDetail returns normalized detail with body text', async () => {
		const cap = buildFastmailEmailCapability(
			fakeJmapClient({
				async read(id) {
					expect(id).toBe('e1')
					return {
						id: 'e1',
						subject: 'Subject',
						from: [{ name: null, email: 'a@x.com' }],
						to: [{ name: null, email: 'me@x.com' }],
						receivedAt: '2026-05-04T10:00:00Z',
						preview: 'preview',
						text: 'hello body'
					}
				}
			})
		)
		const detail = await cap.readDetail({ id: 'e1', purpose: 'briefing-detail' })
		expect(detail.bodyText).toBe('hello body')
		expect(detail.id).toBe('e1')
		expect(detail.from).toBe('a@x.com')
	})

	test('markRead returns success when JMAP succeeds', async () => {
		const seen: string[] = []
		const cap = buildFastmailEmailCapability(
			fakeJmapClient({
				async markRead(id) {
					seen.push(id)
				}
			})
		)
		const result = await cap.markRead({ id: 'e1' })
		expect(result).toEqual({ success: true })
		expect(seen).toEqual(['e1'])
	})

	test('markRead surfaces JMAP failures', async () => {
		const cap = buildFastmailEmailCapability(
			fakeJmapClient({
				async markRead() {
					throw new Error('upstream down')
				}
			})
		)
		await expect(cap.markRead({ id: 'e1' })).rejects.toThrow(/upstream down/)
	})
})

describe('createFastmailEmailProvider', () => {
	test('rejects empty or missing credentials', () => {
		const provider = createFastmailEmailProvider({
			clientFactory: () => fakeJmapClient({})
		})
		expect(() => provider.create(undefined)).toThrow(/missing or invalid token/)
		expect(() => provider.create({})).toThrow(/missing or invalid token/)
		expect(() => provider.create({ token: '' })).toThrow(/missing or invalid token/)
	})

	test('passes credentials to client factory', () => {
		const seen: Array<{ token: string }> = []
		const provider = createFastmailEmailProvider({
			clientFactory: (creds) => {
				seen.push(creds)
				return fakeJmapClient({})
			}
		})
		provider.create({ token: 'tok' })
		expect(seen).toEqual([{ token: 'tok' }])
	})

	test('contract shape: returns object with EmailCapability methods', () => {
		const provider = createFastmailEmailProvider({
			clientFactory: () => fakeJmapClient({})
		})
		const cap = provider.create({ token: 'tok' })
		expect(typeof cap.listUnread).toBe('function')
		expect(typeof cap.readDetail).toBe('function')
		expect(typeof cap.markRead).toBe('function')
	})
})

describe('Fastmail provider via capability broker', () => {
	function emailHost() {
		return defineProviderBackedCapability({
			capability: email,
			methodScopes: {
				listUnread: 'read.unread',
				readDetail: 'read.detail',
				markRead: 'markRead'
			}
		})
	}

	test('registers via defineProvider and serves listUnread end-to-end', async () => {
		const host = emailHost()
		host.defineProvider(
			createFastmailEmailProvider({
				clientFactory: () =>
					fakeJmapClient({
						async list() {
							return [
								{
									id: 'e1',
									subject: 'Hello',
									from: [{ name: null, email: 'sender@x.com' }],
									receivedAt: '2026-05-04T10:00:00Z',
									preview: 'preview'
								}
							]
						}
					})
			})
		)
		const broker = host.createBroker({
			userId: 'u1',
			grants: [{ capability: 'email', scope: 'read.unread', accountId: 'primary' }],
			resolveAccount: () => ({
				providerId: FASTMAIL_PROVIDER_ID,
				credentials: { token: 'tok' }
			})
		})
		const result = (await broker.invoke({
			capability: 'email',
			method: 'listUnread',
			input: { accountId: 'primary' }
		})) as EmailCapability extends { listUnread: (i: never) => Promise<infer R> } ? R : never
		expect(result).toEqual([
			{
				id: 'e1',
				from: 'sender@x.com',
				subject: 'Hello',
				receivedAt: Date.parse('2026-05-04T10:00:00Z'),
				unread: true
			}
		])
	})

	test('markRead via broker returns success', async () => {
		const host = emailHost()
		const seen: string[] = []
		host.defineProvider(
			createFastmailEmailProvider({
				clientFactory: () =>
					fakeJmapClient({
						async markRead(id) {
							seen.push(id)
						}
					})
			})
		)
		const broker = host.createBroker({
			userId: 'u1',
			grants: [{ capability: 'email', scope: 'markRead' }],
			resolveAccount: () => ({
				providerId: FASTMAIL_PROVIDER_ID,
				credentials: { token: 'tok' }
			})
		})
		const result = await broker.invoke({
			capability: 'email',
			method: 'markRead',
			input: { id: 'e1' }
		})
		expect(result).toEqual({ success: true })
		expect(seen).toEqual(['e1'])
	})

	test('provider failure surfaces as CAPABILITY_FAILED through broker', async () => {
		const host = emailHost()
		host.defineProvider(
			createFastmailEmailProvider({
				clientFactory: () =>
					fakeJmapClient({
						async list() {
							throw new Error('upstream down')
						}
					})
			})
		)
		const broker = host.createBroker({
			userId: 'u1',
			grants: [{ capability: 'email', scope: 'read.unread' }],
			resolveAccount: () => ({
				providerId: FASTMAIL_PROVIDER_ID,
				credentials: { token: 'tok' }
			})
		})
		await expect(
			broker.invoke({ capability: 'email', method: 'listUnread', input: {} })
		).rejects.toMatchObject({
			code: 'CAPABILITY_FAILED',
			capability: 'email',
			method: 'listUnread',
			message: 'upstream down'
		})
	})
})
