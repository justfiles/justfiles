import { memStorage, volume } from '@justfiles/fs'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { CapabilityCall } from '../types.ts'
import { volumeAccountStore } from './account.ts'
import { volumeActiveAi } from './active-ai.ts'
import { accountsCapabilities, resolveAiAccount } from './host.ts'
import type { Auth, Provider } from './provider.ts'
import { GMAIL_SCOPE, googleProvider } from './providers/google.ts'
import { icloudProvider } from './providers/icloud.ts'
import { spudProvider } from './providers/spud.ts'

// The credential-bearing stores are internal, so tests drive the four facets through
// `accountsCapabilities` over a real in-memory Volume. State the admin facet can't
// express (pre-granted scopes, a specific active selection) is written straight to the
// account store / active-AI pointer — the same Volume the capabilities read.

const SETTINGS = 'app.justfiles.frieren.settings'

// Real providers with fake acquisition: a provider is data, so a test swaps its
// `auth` by spread. Google's `acquire` echoes the requested scopes as granted
// (modelling incremental consent); its REAL bindings run against a stubbed `fetch`.
// ChatGPT is a hand-rolled ai provider (the real one lives in the daemon).
const neverFlow = {
	authorize: async (): Promise<URL> => {
		throw new Error('no interactive flow in tests')
	}
}

function fakeGoogle(acquire?: Auth['acquire']): Provider {
	return {
		...googleProvider({ flow: neverFlow, client: null }),
		auth: {
			ui: { kind: 'interactive' },
			acquire:
				acquire ??
				(async ({ scopes }) => ({ accountId: 'me@gmail.com', creds: { access: 'g' }, scopes }))
		}
	}
}

type AiBinding = NonNullable<Provider['capabilities']['ai']>

function fakeChatgpt(over: Partial<AiBinding> = {}): Provider {
	return {
		id: 'chatgpt',
		name: 'ChatGPT',
		auth: {
			ui: { kind: 'interactive' },
			acquire: async () => ({ accountId: 'u@openai', creds: { access: 'tok' } })
		},
		capabilities: {
			ai: {
				bind: (account) => ({
					generateText: async () => ({
						text: `${(account.creds as { access: string }).access}:${(account.config as { model?: string } | undefined)?.model ?? 'none'}`
					})
				}),
				models: () => [{ id: 'default', name: 'Default' }],
				defaultModel: () => 'default',
				...over
			}
		}
	}
}

function testProviders(
	over: { google?: Provider; chatgpt?: Provider; spud?: Provider } = {}
): Provider[] {
	return [
		over.google ?? fakeGoogle(),
		icloudProvider(),
		over.chatgpt ?? fakeChatgpt(),
		over.spud ?? spudProvider({ generate: async (_s, p) => `spud:${p}` })
	]
}

async function setup(providers: Provider[] = testProviders()) {
	const vol = volume(memStorage())
	const caps = accountsCapabilities(providers, vol, { firstParty: [SETTINGS] })
	return { caps, vol, accounts: volumeAccountStore(vol), activeAi: volumeActiveAi(vol) }
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
	test('listProviders projects the registry', async () => {
		const { caps } = await setup()
		const list = (await caps.accounts.invoke(admin('listProviders', {}))) as {
			id: string
			authKind: string
			capabilities: string[]
			builtin?: boolean
			credentialsSchema?: unknown
		}[]
		expect(list.map((p) => [p.id, p.authKind, p.capabilities.sort().join('+')])).toEqual([
			['google', 'interactive', 'calendar+email'],
			['icloud', 'form', 'calendar'],
			['chatgpt', 'interactive', 'ai'],
			['spud', 'none', 'ai']
		])
		expect(list.find((p) => p.id === 'spud')?.builtin).toBe(true)
		expect(list.find((p) => p.id === 'icloud')?.credentialsSchema).toBeTruthy()
		expect(list.find((p) => p.id === 'spud')?.credentialsSchema).toBeUndefined()
	})

	test('connect (interactive) derives accountId; connect requests no scopes yet', async () => {
		const { caps, accounts } = await setup()
		expect(await caps.accounts.invoke(admin('connect', { providerId: 'google' }))).toEqual({
			accountId: 'me@gmail.com'
		})
		const account = await accounts.get('me@gmail.com')
		expect(account).toMatchObject({
			id: 'me@gmail.com',
			provider: 'google',
			creds: { access: 'g' }
		})
		expect(account?.scopes ?? []).toEqual([]) // no capability enabled until toggled on
	})

	test('connect (form) keys the account by the acquired identity', async () => {
		const { caps, accounts } = await setup()
		expect(
			await caps.accounts.invoke(
				admin('connect', {
					providerId: 'icloud',
					credentials: { username: 'u@me.com', password: 'p' }
				})
			)
		).toEqual({ accountId: 'u@me.com' })
		expect(await accounts.get('u@me.com')).toMatchObject({
			id: 'u@me.com',
			provider: 'icloud',
			creds: { username: 'u@me.com', password: 'p' }
		})
	})

	test('listAccounts derives enablement from scopes + the active-AI selection', async () => {
		const { caps, accounts, activeAi } = await setup()
		await accounts.put({ id: 'g', provider: 'google', creds: {}, scopes: [GMAIL_SCOPE] })
		await accounts.put({ id: 'u@openai', provider: 'chatgpt', creds: { access: 'tok' } })
		await activeAi.set({ accountId: 'u@openai', model: 'default' })
		const list = (await caps.accounts.invoke(admin('listAccounts', {}))) as {
			accountId: string
			enabled: string[]
			config: { ai?: { model: string; models: unknown[] } }
		}[]
		expect(list.find((a) => a.accountId === 'g')?.enabled).toEqual(['email'])
		const ai = list.find((a) => a.accountId === 'u@openai')
		expect(ai?.enabled).toEqual(['ai'])
		expect(ai?.config.ai).toEqual({
			model: 'default',
			models: [{ id: 'default', name: 'Default' }]
		})
	})

	test('enabling email widens scope via incremental consent; disabling drops it', async () => {
		const { caps, accounts } = await setup()
		await accounts.put({ id: 'me@gmail.com', provider: 'google', creds: { access: 'g' } })
		await caps.accounts.invoke(
			admin('setEnabled', { accountId: 'me@gmail.com', capability: 'email', enabled: true })
		)
		expect((await accounts.get('me@gmail.com'))?.scopes).toContain(GMAIL_SCOPE)
		await caps.accounts.invoke(
			admin('setEnabled', { accountId: 'me@gmail.com', capability: 'email', enabled: false })
		)
		expect((await accounts.get('me@gmail.com'))?.scopes ?? []).not.toContain(GMAIL_SCOPE)
	})

	test('re-enabling a capability whose scope is already granted skips acquisition', async () => {
		const acquire = vi.fn(async ({ scopes }: { scopes: string[] }) => ({
			accountId: 'me@gmail.com',
			creds: { access: 'g2' },
			scopes
		}))
		const { caps, accounts } = await setup(testProviders({ google: fakeGoogle(acquire) }))
		await accounts.put({
			id: 'me@gmail.com',
			provider: 'google',
			creds: { access: 'g' },
			scopes: [GMAIL_SCOPE]
		})
		await caps.accounts.invoke(
			admin('setEnabled', { accountId: 'me@gmail.com', capability: 'email', enabled: true })
		)
		expect(acquire).not.toHaveBeenCalled()
	})

	test('a form provider capability cannot be soft-disabled (disconnect instead)', async () => {
		const { caps } = await setup()
		await caps.accounts.invoke(
			admin('connect', {
				providerId: 'icloud',
				credentials: { username: 'u@me.com', password: 'p' }
			})
		)
		await caps.accounts.invoke(
			admin('setEnabled', { accountId: 'u@me.com', capability: 'calendar', enabled: false })
		)
		const list = (await caps.accounts.invoke(admin('listAccounts', {}))) as {
			accountId: string
			enabled: string[]
		}[]
		expect(list.find((a) => a.accountId === 'u@me.com')?.enabled).toContain('calendar')
	})

	test('ai is single-active: enabling it points the selection, freeing the previous', async () => {
		const { caps, accounts, activeAi } = await setup()
		await accounts.put({ id: 'a1', provider: 'chatgpt', creds: {} })
		await accounts.put({ id: 'a2', provider: 'chatgpt', creds: {} })
		await activeAi.set({ accountId: 'a1' })
		await caps.accounts.invoke(
			admin('setEnabled', {
				accountId: 'a2',
				capability: 'ai',
				enabled: true,
				config: { model: 'default' }
			})
		)
		expect(await activeAi.get()).toEqual({ accountId: 'a2', model: 'default' })
	})

	test('disconnect removes the account and clears the active-AI pointer', async () => {
		const { caps, accounts, activeAi } = await setup()
		await accounts.put({ id: 'u@openai', provider: 'chatgpt', creds: {} })
		await activeAi.set({ accountId: 'u@openai' })
		await caps.accounts.invoke(admin('disconnect', { accountId: 'u@openai' }))
		expect(await accounts.get('u@openai')).toBeUndefined()
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
	test('image.generateImage rides the active-AI selection', async () => {
		const { caps, accounts, activeAi } = await setup(
			testProviders({
				spud: spudProvider({
					generate: async (_s, p) => `spud:${p}`,
					generateImage: async (prompt) => [{ data: `b64:${prompt}`, mimeType: 'image/png' }]
				})
			})
		)
		await accounts.put({ id: 'spud', provider: 'spud', creds: {} })
		await activeAi.set({ accountId: 'spud' })
		await expect(
			caps.image.invoke(use('image', 'generateImage', { prompt: 'a red panda' }))
		).resolves.toEqual({ images: [{ data: 'b64:a red panda', mimeType: 'image/png' }] })
	})

	test('image is UNAVAILABLE when the active AI provider has no image binding', async () => {
		// The default spud provider carries no image engine; chatgpt never does. Either
		// way the active account decides — image swaps (or vanishes) with the AI switch.
		const { caps, accounts, activeAi } = await setup()
		await accounts.put({ id: 'spud', provider: 'spud', creds: {} })
		await activeAi.set({ accountId: 'spud' })
		await expect(
			caps.image.invoke(use('image', 'generateImage', { prompt: 'a red panda' }))
		).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE', capability: 'image' })
	})

	test('email.listUnread fans out across backing accounts, each stamped', async () => {
		// Gmail returns one unread per account, keyed by the bearer token so each
		// account yields a distinct message.
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
		const { caps, accounts } = await setup()
		await accounts.put({
			id: 'g1',
			provider: 'google',
			creds: { access: 't1' },
			scopes: [GMAIL_SCOPE]
		})
		await accounts.put({
			id: 'g2',
			provider: 'google',
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

	test('a use facet with no backing account is UNAVAILABLE', async () => {
		const { caps } = await setup()
		await expect(
			caps.calendar.invoke(use('calendar', 'listToday', { timezone: 'UTC' }))
		).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
	})
})

// `resolveAiAccount` is the account lease the text `ai` capability is built on
// (host-owned, not an accounts capability). It resolves the single active-AI
// selection into a caller-minted backend, forwarding the selected model and a
// `persist` that writes rotated credentials back to the shared account.
describe('resolveAiAccount', () => {
	test('leases the active selection with its model + provider to the caller', async () => {
		const vol = volume(memStorage())
		const accounts = volumeAccountStore(vol)
		const activeAi = volumeActiveAi(vol)
		await accounts.put({ id: 'u@openai', provider: 'chatgpt', creds: { access: 'tok' } })
		await activeAi.set({ accountId: 'u@openai', model: 'default' })
		const lease = await resolveAiAccount(vol, (l) => ({
			creds: l.creds,
			config: l.config,
			providerId: l.providerId
		}))
		expect(lease).toEqual({
			creds: { access: 'tok' },
			config: { model: 'default' },
			providerId: 'chatgpt'
		})
	})

	test('persist writes a rotated credential back to the shared account', async () => {
		const vol = volume(memStorage())
		const accounts = volumeAccountStore(vol)
		const activeAi = volumeActiveAi(vol)
		await accounts.put({ id: 'u@openai', provider: 'chatgpt', creds: { access: 'tok' } })
		await activeAi.set({ accountId: 'u@openai' })
		await resolveAiAccount(vol, (l) => l.persist({ access: 'rotated' }))
		expect((await accounts.get('u@openai'))?.creds).toEqual({ access: 'rotated' })
	})

	test('is null with no active selection', async () => {
		const vol = volume(memStorage())
		expect(await resolveAiAccount(vol, () => 'x')).toBeNull()
	})
})
