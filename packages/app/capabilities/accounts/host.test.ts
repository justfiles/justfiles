import { describe, expect, test } from 'vitest'
import type { CapabilityCall } from '../types.ts'
import type { Account, AccountsStore, Provider, ProviderRegistry } from './host.ts'
import { accountsAdminHost, aiHost, calendarHost, emailHost } from './host.ts'

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

// An oauth ai provider whose mint reads the selected model from per-capability
// config and whose `describe` projects the model picker (selected + available).
function aiProvider(): Provider {
	return {
		id: 'chatgpt',
		name: 'ChatGPT',
		auth: {
			kind: 'oauth',
			signIn: async () => ({ accountId: 'u@openai', creds: { access: 'tok' } })
		},
		mint: {
			ai: (creds, config) => ({
				async generateText() {
					const model = (config as { model?: string } | undefined)?.model ?? 'default'
					return { text: `${creds.access as string}:${model}` }
				}
			})
		},
		describe: {
			ai: (config) => ({
				model: (config as { model?: string } | undefined)?.model ?? 'default',
				models: [{ id: 'default', name: 'Default' }]
			})
		}
	}
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
			{
				id: 'XYZ:1',
				from: 'a@example.com',
				subject: 'hi',
				receivedAt: 1,
				unread: true,
				accountId: 'fastmail'
			}
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
		).resolves.toEqual([
			{ id: 'EV', title: 'standup', startsAt: 1, endsAt: 2, accountId: 'me@icloud.com' }
		])
	})

	test('ai.generateText mints with the account config (selected model)', async () => {
		const registry: ProviderRegistry = new Map([[aiProvider().id, aiProvider()]])
		const store = memoryStore([
			{
				accountId: 'u@openai',
				providerId: 'chatgpt',
				creds: { access: 'tok' },
				enabled: { ai: { model: 'gpt-x' } }
			}
		])
		const host = aiHost(registry, store)
		await expect(host.invoke(useCall('ai', 'generateText', { prompt: 'hi' }))).resolves.toEqual({
			text: 'tok:gpt-x'
		})
	})
})

describe('multi-account fan-out', () => {
	// A form provider backing email; `marker` distinguishes the two accounts' mail.
	function emailProvider(id: string, marker: string): Provider {
		return {
			id,
			name: id,
			auth: { kind: 'form', credentialsSchema: { type: 'object', properties: {} } },
			mint: {
				email: () => ({
					async listUnread() {
						return [
							{
								id: `${marker}-1`,
								from: `${marker}@x`,
								subject: marker,
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
	}
	const registry: ProviderRegistry = new Map([
		['a', emailProvider('a', 'A')],
		['b', emailProvider('b', 'B')]
	])
	const seeded = (): AccountsStore =>
		memoryStore([
			{ accountId: 'acc-a', providerId: 'a', creds: {}, enabled: { email: {} } },
			{ accountId: 'acc-b', providerId: 'b', creds: {}, enabled: { email: {} } }
		])
	const listUnread = (accountId?: string): CapabilityCall => ({
		appId: 'app.any',
		capability: 'email',
		method: 'listUnread',
		args: [accountId ? { accountId } : {}],
		scopes: []
	})

	test('listUnread aggregates across all enabled accounts, each stamped', async () => {
		const res = await emailHost(registry, seeded()).invoke(listUnread())
		expect(res).toEqual([
			{ id: 'A-1', from: 'A@x', subject: 'A', receivedAt: 1, unread: true, accountId: 'acc-a' },
			{ id: 'B-1', from: 'B@x', subject: 'B', receivedAt: 1, unread: true, accountId: 'acc-b' }
		])
	})

	test('an explicit accountId narrows fan-out to that one account', async () => {
		const res = await emailHost(registry, seeded()).invoke(listUnread('acc-b'))
		expect(res).toEqual([
			{ id: 'B-1', from: 'B@x', subject: 'B', receivedAt: 1, unread: true, accountId: 'acc-b' }
		])
	})
})

describe('incremental consent', () => {
	// A Google-like oauth provider declaring a scope per capability; `signIns`
	// records every requested scope set so the test can see when sign-in re-runs.
	function googleProvider(signIns: string[][]): Provider {
		return {
			id: 'google',
			name: 'Google',
			auth: {
				kind: 'oauth',
				scopes: { email: ['gmail.readonly'], calendar: ['calendar.readonly'] },
				signIn: async (requested) => {
					signIns.push(requested)
					return {
						accountId: 'me@gmail.com',
						creds: { tok: requested.join(',') },
						scopes: requested
					}
				}
			},
			mint: {
				email: () => ({
					async listUnread() {
						return []
					},
					async readDetail() {
						throw new Error('unused')
					},
					async markRead() {
						return { success: true } as const
					}
				}),
				calendar: () => ({
					async listToday() {
						return []
					}
				})
			}
		}
	}

	test('connect asks for no scopes; enabling each capability widens and re-signs in', async () => {
		const signIns: string[][] = []
		const store = memoryStore()
		const registry: ProviderRegistry = new Map([['google', googleProvider(signIns)]])
		const admin = accountsAdminHost(registry, store, { firstParty: [SETTINGS] })

		await admin.invoke(call(SETTINGS, 'connect', { providerId: 'google' }))
		expect(signIns).toEqual([[]]) // identity only
		expect((await store.get('me@gmail.com'))?.scopes).toEqual([])

		await admin.invoke(
			call(SETTINGS, 'setEnabled', {
				accountId: 'me@gmail.com',
				capability: 'email',
				enabled: true
			})
		)
		expect(signIns).toEqual([[], ['gmail.readonly']])
		expect((await store.get('me@gmail.com'))?.scopes).toEqual(['gmail.readonly'])

		await admin.invoke(
			call(SETTINGS, 'setEnabled', {
				accountId: 'me@gmail.com',
				capability: 'calendar',
				enabled: true
			})
		)
		expect(signIns).toEqual([[], ['gmail.readonly'], ['gmail.readonly', 'calendar.readonly']])
		const account = await store.get('me@gmail.com')
		expect(account?.scopes).toEqual(['gmail.readonly', 'calendar.readonly'])
		expect(account?.enabled).toEqual({ email: {}, calendar: {} })
	})

	test('re-enabling a capability whose scope is already granted skips sign-in', async () => {
		const signIns: string[][] = []
		const store = memoryStore([
			{
				accountId: 'me@gmail.com',
				providerId: 'google',
				creds: { tok: 'x' },
				scopes: ['gmail.readonly'],
				enabled: {}
			}
		])
		const registry: ProviderRegistry = new Map([['google', googleProvider(signIns)]])
		const admin = accountsAdminHost(registry, store, { firstParty: [SETTINGS] })
		await admin.invoke(
			call(SETTINGS, 'setEnabled', {
				accountId: 'me@gmail.com',
				capability: 'email',
				enabled: true
			})
		)
		expect(signIns).toEqual([]) // scope already held — no browser flow
		expect((await store.get('me@gmail.com'))?.enabled).toEqual({ email: {} })
	})
})

describe('accounts admin config projection', () => {
	test('listAccounts projects per-capability config through provider.describe', async () => {
		const registry: ProviderRegistry = new Map([[aiProvider().id, aiProvider()]])
		const store = memoryStore([
			{
				accountId: 'u@openai',
				providerId: 'chatgpt',
				creds: { access: 'tok' },
				enabled: { ai: {} }
			}
		])
		const admin = accountsAdminHost(registry, store, { firstParty: [SETTINGS] })
		const accounts = (await admin.invoke(call(SETTINGS, 'listAccounts', {}))) as Array<{
			config: { ai?: unknown }
		}>
		expect(accounts[0].config.ai).toEqual({
			model: 'default',
			models: [{ id: 'default', name: 'Default' }]
		})
	})
})
