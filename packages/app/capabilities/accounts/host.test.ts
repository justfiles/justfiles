import { memStorage, volume } from '@justfiles/fs'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { CapabilityCall } from '../types.ts'
import { volumeAccountStore } from './account.ts'
import { volumeActiveAi } from './active-ai.ts'
import {
	accountsCapabilities,
	aesGcmSecretCodec,
	ensureAccount,
	migrateHostPrivateLane,
	renameAccount,
	resolveAiAccount
} from './host.ts'
import type { Auth, Provider } from './provider.ts'
import { GMAIL_SCOPE, googleProvider } from './providers/google.ts'
import { icloudProvider } from './providers/icloud.ts'
import { platformProvider } from './providers/platform.ts'

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
	over: { google?: Provider; chatgpt?: Provider; platform?: Provider } = {}
): Provider[] {
	return [
		over.google ?? fakeGoogle(),
		icloudProvider(),
		over.chatgpt ?? fakeChatgpt(),
		over.platform ?? platformProvider({ generate: async (_s, p) => `platform:${p}` })
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
			['frieren', 'none', 'ai']
		])
		expect(list.find((p) => p.id === 'frieren')?.builtin).toBe(true)
		expect(list.find((p) => p.id === 'icloud')?.credentialsSchema).toBeTruthy()
		expect(list.find((p) => p.id === 'frieren')?.credentialsSchema).toBeUndefined()
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
				platform: platformProvider({
					generate: async (_s, p) => `platform:${p}`,
					generateImage: async (prompt) => [{ data: `b64:${prompt}`, mimeType: 'image/png' }]
				})
			})
		)
		await accounts.put({ id: 'frieren', provider: 'frieren', creds: {} })
		await activeAi.set({ accountId: 'frieren' })
		await expect(
			caps.image.invoke(use('image', 'generateImage', { prompt: 'a red panda' }))
		).resolves.toEqual({ images: [{ data: 'b64:a red panda', mimeType: 'image/png' }] })
	})

	test('image is UNAVAILABLE when the active AI provider has no image binding', async () => {
		// The default platform provider carries no image engine; chatgpt never does. Either
		// way the active account decides — image swaps (or vanishes) with the AI switch.
		const { caps, accounts, activeAi } = await setup()
		await accounts.put({ id: 'frieren', provider: 'frieren', creds: {} })
		await activeAi.set({ accountId: 'frieren' })
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

describe('renameAccount', () => {
	test('moves the account and the active-AI pointer to the new ids', async () => {
		const vol = volume(memStorage())
		const accounts = volumeAccountStore(vol)
		const activeAi = volumeActiveAi(vol)
		await accounts.put({ id: 'old', provider: 'old', creds: {} })
		await activeAi.set({ accountId: 'old', model: 'default' })
		await renameAccount(vol, 'old', { accountId: 'new', providerId: 'new' })
		expect(await accounts.get('old')).toBeUndefined()
		expect(await accounts.get('new')).toMatchObject({ id: 'new', provider: 'new' })
		expect(await activeAi.get()).toEqual({ accountId: 'new', model: 'default' })
	})

	test('is a no-op with no old account, and leaves another active selection alone', async () => {
		const vol = volume(memStorage())
		const accounts = volumeAccountStore(vol)
		const activeAi = volumeActiveAi(vol)
		await activeAi.set({ accountId: 'u@openai' })
		await renameAccount(vol, 'old', { accountId: 'new', providerId: 'new' })
		expect(await accounts.list()).toEqual([])
		expect(await activeAi.get()).toEqual({ accountId: 'u@openai' })
	})
})

// The credential lane moved out of `/system` into the private `/private` root. The
// relocation is a rename on the owning host, and it must never be able to break a boot.
describe('migrateHostPrivateLane', () => {
	const enc = new TextEncoder()
	const dec = new TextDecoder()

	test('renames the legacy dirs so the store reads its records at the new path', async () => {
		const vol = volume(memStorage())
		await vol.mkdir('/system/accounts', { recursive: true })
		await vol.writeFile(
			'/system/accounts/u%40openai.json',
			enc.encode(JSON.stringify({ id: 'u@openai', provider: 'chatgpt', creds: { r: 'SEKRIT' } }))
		)
		await vol.mkdir('/system/connections/chatgpt', { recursive: true })
		await vol.writeFile('/system/connections/chatgpt/default.json', enc.encode('CONN'))

		await migrateHostPrivateLane(vol)

		expect(await volumeAccountStore(vol).get('u@openai')).toMatchObject({ provider: 'chatgpt' })
		expect(dec.decode(await vol.readFile('/private/connections/chatgpt/default.json'))).toBe('CONN')
		// Vacated: an ordinary synced path again, so the delete clears stale replicas
		expect(await vol.exists('/system/accounts')).toBe(false)
		expect(await vol.exists('/system/connections')).toBe(false)
	})

	test('is a no-op on a volume that never had the legacy dirs, and is idempotent', async () => {
		const vol = volume(memStorage())
		const accounts = volumeAccountStore(vol)
		await accounts.put({ id: 'frieren', provider: 'frieren', creds: {} })
		await migrateHostPrivateLane(vol)
		await migrateHostPrivateLane(vol)
		expect(await accounts.list()).toMatchObject([{ id: 'frieren' }])
	})

	// A first attempt that failed (or a reseed that ran first) leaves BOTH trees. The
	// legacy tree must not be dropped wholesale then: a record the host does not already
	// have is a credential the user would otherwise have to re-connect.
	test('fills gaps from the legacy dir, and the host’s own record wins a collision', async () => {
		const vol = volume(memStorage())
		const accounts = volumeAccountStore(vol)
		await accounts.put({ id: 'frieren', provider: 'frieren', creds: {} })
		await vol.mkdir('/system/accounts', { recursive: true })
		await vol.writeFile(
			'/system/accounts/u%40gmail.com.json',
			enc.encode(
				JSON.stringify({ id: 'u@gmail.com', provider: 'google', creds: { refresh: 'KEEP' } })
			)
		)
		// Same id on both sides: the host's live record must not be overwritten by the copy.
		await vol.writeFile(
			'/system/accounts/frieren.json',
			enc.encode(JSON.stringify({ id: 'frieren', provider: 'frieren', creds: { stale: true } }))
		)

		await migrateHostPrivateLane(vol)

		expect(await accounts.get('u@gmail.com')).toMatchObject({ creds: { refresh: 'KEEP' } })
		expect(await accounts.get('frieren')).toMatchObject({ creds: {} })
		expect(await vol.exists('/system/accounts')).toBe(false)
	})

	test('never throws: a volume that refuses the move still lets the host boot', async () => {
		const vol = volume(memStorage())
		await vol.mkdir('/system/accounts', { recursive: true })
		await vol.writeFile('/system/accounts/a.json', enc.encode('{}'))
		const boom = { ...vol, rename: async () => Promise.reject(new Error('EPERM')) }
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		await expect(migrateHostPrivateLane(boom)).resolves.toBeUndefined()
		expect(warn).toHaveBeenCalled()
		// The legacy record is left where it is — a failed move must not delete it.
		expect(await vol.exists('/system/accounts/a.json')).toBe(true)
		warn.mockRestore()
	})
})

// Encryption at rest is one codec shared by EVERY entry point that builds the store: a
// codec on some but not all of them means half the reads can't decrypt, so these tests
// pin the wiring, not the crypto (see secret-codec.test.ts for that).
describe('secretCodec wiring', () => {
	const codec = aesGcmSecretCodec('host-key')

	test('one codec across accountsCapabilities, ensureAccount, resolveAiAccount, renameAccount', async () => {
		const vol = volume(memStorage())
		const caps = accountsCapabilities(testProviders(), vol, {
			firstParty: [SETTINGS],
			secretCodec: codec
		})
		await caps.accounts.invoke(admin('connect', { providerId: 'chatgpt' }))
		await caps.accounts.invoke(
			admin('setEnabled', { accountId: 'u@openai', capability: 'ai', enabled: true })
		)
		// On disk the creds are sealed; the facet that needs them still reads them.
		const raw = new TextDecoder().decode(await vol.readFile('/private/accounts/u%40openai.json'))
		expect(raw).not.toContain('tok')
		await expect(resolveAiAccount(vol, (l) => l.creds, { secretCodec: codec })).resolves.toEqual({
			access: 'tok'
		})
		// A rename re-seals under the new id (the id is the AAD), so the record still opens.
		await renameAccount(
			vol,
			'u@openai',
			{ accountId: 'moved', providerId: 'chatgpt' },
			{
				secretCodec: codec
			}
		)
		await expect(resolveAiAccount(vol, (l) => l.creds, { secretCodec: codec })).resolves.toEqual({
			access: 'tok'
		})
		// ensureAccount seals its seed too, and still sees an existing account as present.
		await ensureAccount(
			vol,
			{ accountId: 'frieren', providerId: 'frieren', enabled: [] },
			{
				secretCodec: codec
			}
		)
		const seeded = JSON.parse(
			new TextDecoder().decode(await vol.readFile('/private/accounts/frieren.json'))
		)
		expect(seeded.creds).toMatchObject({ v: 1, alg: 'A256GCM' })
	})

	test('a credential-less seed heals a record the key can no longer open', async () => {
		// Rotating the key would otherwise leave the platform AI account listed-but-dead,
		// i.e. no agent backend. It carries no secret, so re-seeding it costs nothing.
		const vol = volume(memStorage())
		await volumeAccountStore(vol, { secretCodec: aesGcmSecretCodec('old-key') }).put({
			id: 'frieren',
			provider: 'frieren',
			creds: {}
		})
		await ensureAccount(
			vol,
			{ accountId: 'frieren', providerId: 'frieren', enabled: ['ai'] },
			{
				secretCodec: codec
			}
		)
		expect((await volumeAccountStore(vol, { secretCodec: codec }).get('frieren'))?.creds).toEqual(
			{}
		)
	})

	test('a record this host cannot decrypt lists with an error and is unusable', async () => {
		// The rotated/missing-key path, end to end: Settings still renders the account (so
		// the user can re-connect it) and a credential-using call reports UNAVAILABLE rather
		// than leaking a decrypt exception.
		const vol = volume(memStorage())
		await volumeAccountStore(vol, { secretCodec: aesGcmSecretCodec('old-key') }).put({
			id: 'me@gmail.com',
			provider: 'google',
			creds: { refresh: 'r' },
			scopes: [GMAIL_SCOPE]
		})
		const caps = accountsCapabilities(testProviders(), vol, {
			firstParty: [SETTINGS],
			secretCodec: codec
		})
		const list = (await caps.accounts.invoke(admin('listAccounts', {}))) as {
			accountId: string
			providerId: string
			lastError?: string
		}[]
		expect(list).toMatchObject([{ accountId: 'me@gmail.com', providerId: 'google' }])
		expect(list[0].lastError).toBeTruthy()
		await expect(caps.email.invoke(use('email', 'listUnread', { limit: 1 }))).rejects.toMatchObject(
			{ code: 'CAPABILITY_UNAVAILABLE' }
		)
	})
})
