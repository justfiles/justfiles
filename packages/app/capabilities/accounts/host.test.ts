import { describe, expect, test } from 'vitest'
import type { CapabilityCall } from '../types.ts'
import type { Account, AccountsStore, Provider, ProviderRegistry } from './host.ts'
import { accountsAdminHost, calendarHost, emailHost } from './host.ts'

// Minimal in-memory store; the real frieren/quay stores encrypt creds at rest.
function memoryStore(seed: Account[] = []): AccountsStore {
	const map = new Map(seed.map((a) => [a.accountId, a]))
	return {
		list: async () => [...map.values()],
		get: async (id) => map.get(id),
		put: async (a) => void map.set(a.accountId, a),
		delete: async (id) => void map.delete(id)
	}
}

const SETTINGS = 'app.frieren.settings'

// A form provider that backs email, and an oauth provider that backs calendar —
// enough to exercise both auth kinds and the use-facet dispatch.
function providers(): ProviderRegistry {
	const fastmail: Provider = {
		id: 'fastmail',
		name: 'Fastmail',
		auth: {
			kind: 'form',
			credentialsSchema: { type: 'object', properties: { token: { type: 'string', minLength: 1 } } }
		},
		mint: {
			email: (creds) => ({
				async listUnread() {
					return [
						{
							id: `${creds.token as string}:1`,
							from: 'a@example.com',
							subject: 'hi',
							receivedAt: 1,
							unread: true
						}
					]
				},
				async readDetail() {
					throw new Error('unused')
				},
				async markRead() {
					return { success: true } as const
				}
			})
		}
	}
	const ic: Provider = {
		id: 'icloud',
		name: 'iCloud',
		auth: {
			kind: 'oauth',
			signIn: async () => ({ accountId: 'me@icloud.com', creds: { token: 'cal' } })
		},
		mint: {
			calendar: (creds) => ({
				async listToday() {
					return [{ id: creds.token as string, title: 'standup', startsAt: 1, endsAt: 2 }]
				}
			})
		}
	}
	return new Map([
		[fastmail.id, fastmail],
		[ic.id, ic]
	])
}

function call(appId: string, method: string, ...args: unknown[]): CapabilityCall {
	return { appId, capability: 'accounts', method, args, scopes: ['admin'] }
}

describe('accounts admin host', () => {
	test('connect (form) stores an account with no capabilities enabled', async () => {
		const store = memoryStore()
		const admin = accountsAdminHost(providers(), store, { firstParty: [SETTINGS] })
		const res = await admin.invoke(
			call(SETTINGS, 'connect', { providerId: 'fastmail', credentials: { token: 't' } })
		)
		expect(res).toEqual({ accountId: 'fastmail' })
		const accounts = await admin.invoke(call(SETTINGS, 'listAccounts', {}))
		expect(accounts).toEqual([
			{
				accountId: 'fastmail',
				providerId: 'fastmail',
				enabled: [],
				config: {},
				lastError: undefined
			}
		])
	})

	test('connect (oauth) derives accountId from the sign-in identity', async () => {
		const store = memoryStore()
		const admin = accountsAdminHost(providers(), store, { firstParty: [SETTINGS] })
		const res = await admin.invoke(call(SETTINGS, 'connect', { providerId: 'icloud' }))
		expect(res).toEqual({ accountId: 'me@icloud.com' })
	})

	test('listProviders projects auth kind, capabilities, and form schema only', async () => {
		const admin = accountsAdminHost(providers(), memoryStore(), { firstParty: [SETTINGS] })
		const infos = await admin.invoke(call(SETTINGS, 'listProviders', {}))
		expect(infos).toEqual([
			{
				id: 'fastmail',
				name: 'Fastmail',
				authKind: 'form',
				capabilities: ['email'],
				credentialsSchema: {
					type: 'object',
					properties: { token: { type: 'string', minLength: 1 } }
				}
			},
			{
				id: 'icloud',
				name: 'iCloud',
				authKind: 'oauth',
				capabilities: ['calendar'],
				credentialsSchema: undefined
			}
		])
	})

	test('setEnabled toggles a capability and preserves config across re-enable', async () => {
		const store = memoryStore([
			{ accountId: 'fastmail', providerId: 'fastmail', creds: { token: 't' }, enabled: {} }
		])
		const admin = accountsAdminHost(providers(), store, { firstParty: [SETTINGS] })
		await admin.invoke(
			call(SETTINGS, 'setEnabled', { accountId: 'fastmail', capability: 'email', enabled: true })
		)
		expect((await store.get('fastmail'))?.enabled).toEqual({ email: {} })
		await admin.invoke(
			call(SETTINGS, 'setEnabled', { accountId: 'fastmail', capability: 'email', enabled: false })
		)
		expect((await store.get('fastmail'))?.enabled).toEqual({})
	})

	test('non-first-party app cannot tell the facet exists', async () => {
		const admin = accountsAdminHost(providers(), memoryStore(), { firstParty: [SETTINGS] })
		await expect(admin.invoke(call('app.evil', 'listAccounts', {}))).rejects.toMatchObject({
			code: 'CAPABILITY_UNAVAILABLE'
		})
	})
})

describe('accounts use-facet dispatch', () => {
	function useCall(capability: string, method: string, input: unknown): CapabilityCall {
		return { appId: 'app.any', capability, method, args: [input], scopes: [] }
	}

	test('email.listUnread resolves through the enabled account to its provider', async () => {
		const store = memoryStore([
			{
				accountId: 'fastmail',
				providerId: 'fastmail',
				creds: { token: 'XYZ' },
				enabled: { email: {} }
			}
		])
		const host = emailHost(providers(), store)
		await expect(host.invoke(useCall('email', 'listUnread', {}))).resolves.toEqual([
			{ id: 'XYZ:1', from: 'a@example.com', subject: 'hi', receivedAt: 1, unread: true }
		])
	})

	test('a capability with no enabled account is UNAVAILABLE', async () => {
		const host = calendarHost(providers(), memoryStore())
		await expect(
			host.invoke(useCall('calendar', 'listToday', { timezone: 'UTC' }))
		).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
	})

	test('calendar.listToday resolves through an oauth-connected account', async () => {
		const store = memoryStore([
			{
				accountId: 'me@icloud.com',
				providerId: 'icloud',
				creds: { token: 'EV' },
				enabled: { calendar: {} }
			}
		])
		const host = calendarHost(providers(), store)
		await expect(
			host.invoke(useCall('calendar', 'listToday', { timezone: 'UTC' }))
		).resolves.toEqual([{ id: 'EV', title: 'standup', startsAt: 1, endsAt: 2 }])
	})
})
