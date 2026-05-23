import { defineProviderBackedCapability } from '@justfiles/app/kernel/capabilities/broker'
import { email } from '@justfiles/app/kernel/capabilities/email'
import { describe, expect, test } from 'vitest'
import type { EmailDetails, EmailSummary, JmapClient, SendInput } from './jmap.ts'
import { createFastmailEmailProvider, fastmailEmailProvider } from './provider.ts'

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

function providerWith(state: FakeJmapState) {
	return createFastmailEmailProvider({ clientFactory: () => fakeJmapClient(state) })
}

describe('fastmailEmailProvider', () => {
	test('rejects missing or empty token', () => {
		const provider = providerWith({})
		expect(() => provider.create(undefined)).toThrow(/missing or invalid token/)
		expect(() => provider.create({})).toThrow(/missing or invalid token/)
		expect(() => provider.create({ token: '' })).toThrow(/missing or invalid token/)
	})

	test('passes token through to client factory', () => {
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

	test('listUnread requests unread filter and normalizes results', async () => {
		const seenOptions: Array<{ limit: number; unread?: boolean }> = []
		const cap = providerWith({
			async list(options) {
				seenOptions.push(options)
				return [
					{
						id: 'e1',
						subject: 'Hi',
						from: [{ name: 'Bob', email: 'bob@x.com' }],
						receivedAt: '2026-05-04T10:00:00Z',
						preview: 'hello'
					},
					{
						id: 'e2',
						subject: null,
						from: [{ name: null, email: 'a@x.com' }],
						receivedAt: '2026-05-03T10:00:00Z',
						preview: ''
					}
				]
			}
		}).create({ token: 'tok' })

		const result = await cap.listUnread({ limit: 5 })
		expect(seenOptions).toEqual([{ limit: 5, unread: true }])
		expect(result).toEqual([
			{
				id: 'e1',
				from: 'Bob <bob@x.com>',
				subject: 'Hi',
				receivedAt: Date.parse('2026-05-04T10:00:00Z'),
				unread: true
			},
			{
				id: 'e2',
				from: 'a@x.com',
				subject: '',
				receivedAt: Date.parse('2026-05-03T10:00:00Z'),
				unread: true
			}
		])
	})

	test('listUnread defaults limit to 20', async () => {
		let seenLimit = -1
		const cap = providerWith({
			async list(options) {
				seenLimit = options.limit
				return []
			}
		}).create({ token: 'tok' })
		await cap.listUnread({})
		expect(seenLimit).toBe(20)
	})

	test('readDetail returns normalized detail with body text', async () => {
		const cap = providerWith({
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
		}).create({ token: 'tok' })

		const detail = await cap.readDetail({ id: 'e1', purpose: 'briefing-detail' })
		expect(detail).toEqual({
			id: 'e1',
			from: 'a@x.com',
			subject: 'Subject',
			receivedAt: Date.parse('2026-05-04T10:00:00Z'),
			unread: false,
			bodyText: 'hello body'
		})
	})

	test('markRead returns success when JMAP succeeds', async () => {
		const seen: string[] = []
		const cap = providerWith({
			async markRead(id) {
				seen.push(id)
			}
		}).create({ token: 'tok' })
		await expect(cap.markRead({ id: 'e1' })).resolves.toEqual({ success: true })
		expect(seen).toEqual(['e1'])
	})

	test('provider methods surface JMAP failures', async () => {
		const cap = providerWith({
			async list() {
				throw new Error('upstream down')
			}
		}).create({ token: 'tok' })
		await expect(cap.listUnread({})).rejects.toThrow(/upstream down/)
	})

	test('default fastmailEmailProvider exposes the same id and shape', () => {
		expect(fastmailEmailProvider.id).toBe('fastmail')
		const cap = fastmailEmailProvider.create({ token: 'tok' })
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
		const provider = providerWith({
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
		host.defineProvider(provider)
		const broker = host.createBroker({
			userId: 'u1',
			grants: [{ capability: 'email', scope: 'read.unread', accountId: 'primary' }],
			resolveAccount: () => ({ providerId: provider.id, credentials: { token: 'tok' } })
		})
		await expect(
			broker.invoke({
				capability: 'email',
				method: 'listUnread',
				input: { accountId: 'primary' }
			})
		).resolves.toEqual([
			{
				id: 'e1',
				from: 'sender@x.com',
				subject: 'Hello',
				receivedAt: Date.parse('2026-05-04T10:00:00Z'),
				unread: true
			}
		])
	})

	test('provider failure surfaces as CAPABILITY_FAILED through broker', async () => {
		const host = emailHost()
		const provider = providerWith({
			async list() {
				throw new Error('upstream down')
			}
		})
		host.defineProvider(provider)
		const broker = host.createBroker({
			userId: 'u1',
			grants: [{ capability: 'email', scope: 'read.unread' }],
			resolveAccount: () => ({ providerId: provider.id, credentials: { token: 'tok' } })
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
