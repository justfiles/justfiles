import { memStorage, volume } from '@justfiles/fs'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { CapabilityCall } from '../types.ts'
import { volumeActiveAi } from './active-ai.ts'
import { volumeConnectionStore } from './connection.ts'
import { type AccountsDeps, accountsCapabilities } from './host.ts'
import { GMAIL_SCOPE } from './provider-caps.ts'

// The credential-bearing stores are internal, so tests drive the four facets through
// `accountsCapabilities` over a real in-memory Volume. State the admin facet can't
// express (pre-granted scopes, a specific active selection) is written straight to the
// connection store / active-AI pointer — the same Volume the capabilities read.

const SETTINGS = 'computer.spud.settings'

// Real provider kinds with fake host seams: `signIn` echoes the requested scopes as
// granted (modelling incremental consent), `mintAi` returns canned text, `generate` is
// the platform AI. The Gmail/CalDAV clients hit the network, so email/calendar dispatch
// is tested against a stubbed `fetch` below.
function deps(over: Partial<AccountsDeps> = {}): AccountsDeps {
	return {
		google: {
			signIn: async (requested) => ({
				accountId: 'me@gmail.com',
				creds: { access: 'g' },
				scopes: requested
			}),
			refreshClient: null
		},
		icloud: true,
		chatgpt: {
			signIn: async () => ({ accountId: 'u@openai', creds: { access: 'tok' } }),
			mintAi: (creds, config) => ({
				generateText: async () => ({
					text: `${(creds as { access: string }).access}:${(config as { model?: string })?.model ?? 'none'}`
				})
			}),
			models: () => [{ id: 'default', name: 'Default' }],
			defaultModel: () => 'default'
		},
		spud: { generate: async (_s, p) => `spud:${p}` },
		...over
	}
}

async function setup(d: AccountsDeps = deps()) {
	const vol = volume(memStorage())
	const caps = await accountsCapabilities(d, vol, { firstParty: [SETTINGS] })
	return { caps, vol, connections: volumeConnectionStore(vol), activeAi: volumeActiveAi(vol) }
}

function admin(method: string, args: unknown): CapabilityCall {
	return { appId: SETTINGS, capability: 'accounts', method, args: [args], scopes: ['admin'] }
}
function use(capability: string, method: string, input: unknown): CapabilityCall {
	return { appId: 'app.any', capability, method, args: [input], scopes: [] }
}
function json(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200 })
}

afterEach(() => vi.unstubAllGlobals())

describe('accounts admin host', () => {
	test('listProviders projects the catalog for the supplied providers', async () => {
		const { caps } = await setup()
		const list = (await caps.accounts.invoke(admin('listProviders', {}))) as {
			id: string
			authKind: string
			capabilities: string[]
			builtin?: boolean
			credentialsSchema?: unknown
		}[]
		expect(list.map((p) => [p.id, p.authKind, p.capabilities.sort().join('+')])).toEqual([
			['google', 'oauth', 'calendar+email'],
			['icloud', 'form', 'calendar'],
			['chatgpt', 'oauth', 'ai'],
			['spud', 'form', 'ai']
		])
		expect(list.find((p) => p.id === 'spud')?.builtin).toBe(true)
		expect(list.find((p) => p.id === 'icloud')?.credentialsSchema).toBeTruthy()
	})

	test('connect (oauth) derives accountId; connect requests no scopes yet', async () => {
		const { caps, connections } = await setup()
		expect(await caps.accounts.invoke(admin('connect', { providerId: 'google' }))).toEqual({
			accountId: 'me@gmail.com'
		})
		const conn = await connections.get('me@gmail.com')
		expect(conn).toMatchObject({ id: 'me@gmail.com', kind: 'google', creds: { access: 'g' } })
		expect(conn?.scopes ?? []).toEqual([]) // no capability enabled until toggled on
	})

	test('connect (form) stores a connection keyed by provider', async () => {
		const { caps, connections } = await setup()
		await caps.accounts.invoke(
			admin('connect', { providerId: 'icloud', credentials: { username: 'u', password: 'p' } })
		)
		expect(await connections.get('icloud')).toMatchObject({
			id: 'icloud',
			kind: 'icloud',
			creds: { username: 'u', password: 'p' }
		})
	})

	test('listAccounts derives enablement from scopes + the active-AI selection', async () => {
		const { caps, connections, activeAi } = await setup()
		await connections.put({ id: 'g', kind: 'google', creds: {}, scopes: [GMAIL_SCOPE] })
		await connections.put({ id: 'u@openai', kind: 'chatgpt', creds: { access: 'tok' } })
		await activeAi.set({ connectionId: 'u@openai', model: 'default' })
		const accounts = (await caps.accounts.invoke(admin('listAccounts', {}))) as {
			accountId: string
			enabled: string[]
			config: { ai?: { model: string; models: unknown[] } }
		}[]
		expect(accounts.find((a) => a.accountId === 'g')?.enabled).toEqual(['email'])
		const ai = accounts.find((a) => a.accountId === 'u@openai')
		expect(ai?.enabled).toEqual(['ai'])
		expect(ai?.config.ai).toEqual({
			model: 'default',
			models: [{ id: 'default', name: 'Default' }]
		})
	})

	test('enabling email widens scope via incremental consent; disabling drops it', async () => {
		const { caps, connections } = await setup()
		await connections.put({ id: 'me@gmail.com', kind: 'google', creds: { access: 'g' } })
		await caps.accounts.invoke(
			admin('setEnabled', { accountId: 'me@gmail.com', capability: 'email', enabled: true })
		)
		expect((await connections.get('me@gmail.com'))?.scopes).toContain(GMAIL_SCOPE)
		await caps.accounts.invoke(
			admin('setEnabled', { accountId: 'me@gmail.com', capability: 'email', enabled: false })
		)
		expect((await connections.get('me@gmail.com'))?.scopes ?? []).not.toContain(GMAIL_SCOPE)
	})

	test('re-enabling a capability whose scope is already granted skips sign-in', async () => {
		const signIn = vi.fn(async (requested: string[]) => ({
			accountId: 'me@gmail.com',
			creds: { access: 'g2' },
			scopes: requested
		}))
		const { caps, connections } = await setup(deps({ google: { signIn, refreshClient: null } }))
		await connections.put({
			id: 'me@gmail.com',
			kind: 'google',
			creds: { access: 'g' },
			scopes: [GMAIL_SCOPE]
		})
		await caps.accounts.invoke(
			admin('setEnabled', { accountId: 'me@gmail.com', capability: 'email', enabled: true })
		)
		expect(signIn).not.toHaveBeenCalled()
	})

	test('a form provider capability cannot be soft-disabled (disconnect instead)', async () => {
		const { caps } = await setup()
		await caps.accounts.invoke(
			admin('connect', { providerId: 'icloud', credentials: { username: 'u', password: 'p' } })
		)
		await caps.accounts.invoke(
			admin('setEnabled', { accountId: 'icloud', capability: 'calendar', enabled: false })
		)
		const accounts = (await caps.accounts.invoke(admin('listAccounts', {}))) as {
			accountId: string
			enabled: string[]
		}[]
		expect(accounts.find((a) => a.accountId === 'icloud')?.enabled).toContain('calendar')
	})

	test('ai is single-active: enabling it points the selection, freeing the previous', async () => {
		const { caps, connections, activeAi } = await setup()
		await connections.put({ id: 'a1', kind: 'chatgpt', creds: {} })
		await connections.put({ id: 'a2', kind: 'chatgpt', creds: {} })
		await activeAi.set({ connectionId: 'a1' })
		await caps.accounts.invoke(
			admin('setEnabled', {
				accountId: 'a2',
				capability: 'ai',
				enabled: true,
				config: { model: 'default' }
			})
		)
		expect(await activeAi.get()).toEqual({ connectionId: 'a2', model: 'default' })
	})

	test('disconnect removes the connection and clears the active-AI pointer', async () => {
		const { caps, connections, activeAi } = await setup()
		await connections.put({ id: 'u@openai', kind: 'chatgpt', creds: {} })
		await activeAi.set({ connectionId: 'u@openai' })
		await caps.accounts.invoke(admin('disconnect', { accountId: 'u@openai' }))
		expect(await connections.get('u@openai')).toBeUndefined()
		expect(await activeAi.get()).toBeNull()
	})

	test('non-first-party app cannot tell the facet exists', async () => {
		const { caps } = await setup()
		await expect(
			caps.accounts.invoke({ ...admin('listAccounts', {}), appId: 'app.evil' })
		).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
	})
})

describe('use-facet dispatch', () => {
	test('ai.generateText mints over the active selection with its model', async () => {
		const { caps, connections, activeAi } = await setup()
		await connections.put({ id: 'u@openai', kind: 'chatgpt', creds: { access: 'tok' } })
		await activeAi.set({ connectionId: 'u@openai', model: 'default' })
		await expect(
			caps.ai.invoke(use('ai', 'generateText', { system: '', prompt: 'hi' }))
		).resolves.toEqual({ text: 'tok:default' })
	})

	test('ai.generateText is UNAVAILABLE with no active selection', async () => {
		const { caps } = await setup()
		await expect(
			caps.ai.invoke(use('ai', 'generateText', { system: '', prompt: 'hi' }))
		).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
	})

	test('email.listUnread fans out across backing connections, each stamped', async () => {
		// Gmail returns one unread per account, keyed by the bearer token so each
		// connection yields a distinct message.
		vi.stubGlobal('fetch', async (url: string, init?: { headers?: Record<string, string> }) => {
			const token = init?.headers?.authorization?.replace('Bearer ', '')
			if (url.includes('/messages?q=is:unread')) return json({ messages: [{ id: `${token}-m1` }] })
			const id = url.split('/messages/')[1]?.split('?')[0]
			return json({
				id,
				internalDate: '1',
				labelIds: ['UNREAD'],
				payload: {
					headers: [
						{ name: 'From', value: 'a@x.com' },
						{ name: 'Subject', value: 'hi' }
					]
				}
			})
		})
		const { caps, connections } = await setup()
		await connections.put({
			id: 'g1',
			kind: 'google',
			creds: { access: 't1' },
			scopes: [GMAIL_SCOPE]
		})
		await connections.put({
			id: 'g2',
			kind: 'google',
			creds: { access: 't2' },
			scopes: [GMAIL_SCOPE]
		})
		const unread = (await caps.email.invoke(use('email', 'listUnread', {}))) as {
			id: string
			accountId: string
		}[]
		expect(unread.map((m) => [m.accountId, m.id]).sort()).toEqual([
			['g1', 't1-m1'],
			['g2', 't2-m1']
		])
	})

	test('a use facet with no backing connection is UNAVAILABLE', async () => {
		const { caps } = await setup()
		await expect(
			caps.calendar.invoke(use('calendar', 'listToday', { timezone: 'UTC' }))
		).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
	})
})

describe('accountsCapabilities (Volume entry point)', () => {
	test('migrates legacy accounts into connections on first build', async () => {
		const vol = volume(memStorage())
		// Seed a pre-connection account file directly.
		await vol.mkdir('/system/accounts', { recursive: true })
		await vol.writeFile(
			'/system/accounts/g.json',
			new TextEncoder().encode(
				JSON.stringify({
					accountId: 'g',
					providerId: 'google',
					creds: { access: 'g' },
					enabled: { email: {} },
					scopes: [GMAIL_SCOPE]
				})
			)
		)
		const caps = await accountsCapabilities(deps(), vol, { firstParty: [SETTINGS] })
		const accounts = (await caps.accounts.invoke(admin('listAccounts', {}))) as {
			accountId: string
			enabled: string[]
		}[]
		expect(accounts.find((a) => a.accountId === 'g')?.enabled).toEqual(['email'])
	})
})
