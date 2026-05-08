import { describe, expect, test } from 'bun:test'
import { defineProviderBackedCapability } from './broker.js'
import type { EmailCapability } from './email/index.js'
import { email } from './email/index.js'

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

describe('provider-backed capability broker', () => {
	test('invokes provider methods when grant allows the call', async () => {
		const host = emailHost()
		host.defineProvider({
			id: 'fastmail',
			create(): EmailCapability {
				return {
					async listUnread(input) {
						return [
							{
								id: `${input.accountId}:1`,
								from: 'a@example.com',
								subject: 'hello',
								receivedAt: 1,
								unread: true
							}
						]
					},
					async readDetail() {
						throw new Error('unused')
					},
					async markRead() {
						return { success: true }
					}
				}
			}
		})

		const broker = host.createBroker({
			userId: 'u1',
			grants: [{ capability: 'email', scope: 'read.unread', accountId: 'primary' }],
			resolveAccount: ({ accountId }) => ({ providerId: 'fastmail', credentials: { accountId } })
		})

		await expect(
			broker.invoke({ capability: 'email', method: 'listUnread', input: { accountId: 'primary' } })
		).resolves.toEqual([
			{
				id: 'primary:1',
				from: 'a@example.com',
				subject: 'hello',
				receivedAt: 1,
				unread: true
			}
		])
	})

	test('denies every call without a matching grant', async () => {
		const host = emailHost()
		host.defineProvider({
			id: 'fastmail',
			create(): EmailCapability {
				throw new Error('provider must not be created')
			}
		})
		const audit: unknown[] = []
		const broker = host.createBroker({
			userId: 'u1',
			grants: [{ capability: 'email', scope: 'read.detail' }],
			resolveAccount: () => ({ providerId: 'fastmail', credentials: {} }),
			audit: (event) => {
				audit.push(event)
			}
		})

		const promise = broker.invoke({ capability: 'email', method: 'listUnread', input: {} })
		await expect(promise).rejects.toMatchObject({
			code: 'CAPABILITY_DENIED',
			capability: 'email',
			method: 'listUnread'
		})
		expect(audit).toEqual([
			{
				capability: 'email',
				method: 'listUnread',
				accountId: undefined,
				outcome: 'denied',
				message: 'missing scope: read.unread'
			}
		])
	})

	test('normalizes provider failures', async () => {
		const host = emailHost()
		host.defineProvider({
			id: 'fastmail',
			create(): EmailCapability {
				return {
					async listUnread() {
						throw new Error('upstream down')
					},
					async readDetail() {
						throw new Error('unused')
					},
					async markRead() {
						return { success: true }
					}
				}
			}
		})
		const broker = host.createBroker({
			userId: 'u1',
			grants: [{ capability: 'email', scope: 'read.unread' }],
			resolveAccount: () => ({ providerId: 'fastmail', credentials: {} })
		})

		try {
			await broker.invoke({ capability: 'email', method: 'listUnread', input: {} })
			throw new Error('expected failure')
		} catch (error) {
			expect(error).toMatchObject({
				code: 'CAPABILITY_FAILED',
				capability: 'email',
				method: 'listUnread',
				message: 'upstream down'
			})
		}
	})
})
