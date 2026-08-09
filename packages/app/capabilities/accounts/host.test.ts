import { memStorage, type Volume, volume } from '@justfiles/fs'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { CapabilityCall } from '../types.ts'
import { type Account, type AccountStore, type SecretCodec, volumeAccountStore } from './account.ts'
import { volumeActiveAi } from './active-ai.ts'
import { aesGcmSecretCodec, hostAccounts } from './host.ts'
import type { Auth, Provider } from './provider.ts'
import { GMAIL_SCOPE, googleProvider } from './providers/google.ts'
import { icloudProvider } from './providers/icloud.ts'
import { platformProvider } from './providers/platform.ts'

// The credential-bearing store is internal, so tests drive the facets through
// `hostAccounts` over a real in-memory Volume. State the admin surface can't express
// (pre-granted scopes, a specific active selection) is written straight to the account
// store / active-AI pointer — the same Volume the module reads.
// The admin impl is a plain object (it reaches apps only through the gated `settings`
// capability — see settings/host.test.ts for the gate), so it is called directly here.

// Real providers with fake acquisition: a provider is data, so a test swaps its
// `auth` by spread. Google's `acquire` echoes the requested scopes as granted
// (modelling incremental consent); its REAL bindings run against a stubbed `fetch`.
// ChatGPT is a hand-rolled ai provider (the real one lives in the daemon).
const neverFlow = {
	authorize: async (): Promise<URL> => {
		throw new Error('no interactive flow in tests')
	}
}

// Google's real bindings need client creds to turn a refresh token into a bearer; the
// stubbed token endpoint in the fan-out test mints `<refresh>-tok`, so each account's
// calls stay distinguishable.
const GOOGLE_CLIENT = { id: 'cid', secret: 'csec' }

function fakeGoogle(acquire?: Auth['acquire']): Provider {
	return {
		...googleProvider({ flow: neverFlow, client: GOOGLE_CLIENT }),
		auth: {
			ui: { kind: 'interactive' },
			acquire:
				acquire ??
				(async ({ scopes }) => ({
					accountId: 'me@gmail.com',
					creds: { refresh: 'R', accountId: 'me@gmail.com' },
					scopes
				}))
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

// The store's only write is a read/decide/write; "just store this record" is the change
// that ignores what was there (see account.test.ts).
const put = (store: AccountStore, account: Account): Promise<void> =>
	store.update(account.id, () => account)

async function setup(providers: Provider[] = testProviders()) {
	const vol = volume(memStorage())
	const caps = hostAccounts(providers, vol)
	return { caps, vol, accounts: volumeAccountStore(vol), activeAi: volumeActiveAi(vol) }
}

function use(capability: string, method: string, input: unknown): CapabilityCall {
	return { appId: 'app.any', capability, method, args: [input], scopes: [] }
}
function json(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200 })
}
async function until(check: () => Promise<void> | void): Promise<void> {
	let last: unknown
	for (let i = 0; i < 200; i++) {
		try {
			await check()
			return
		} catch (e) {
			last = e
			await new Promise((r) => setTimeout(r, 5))
		}
	}
	throw last
}

afterEach(() => vi.unstubAllGlobals())

describe('accounts admin impl', () => {
	test('listProviders projects the registry', async () => {
		const { caps } = await setup()
		const list = await caps.admin.listProviders({})
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
		expect(await caps.admin.connect({ providerId: 'google' })).toEqual({
			accountId: 'me@gmail.com'
		})
		const account = await accounts.get('me@gmail.com')
		expect(account).toMatchObject({
			id: 'me@gmail.com',
			provider: 'google',
			creds: { refresh: 'R', accountId: 'me@gmail.com' }
		})
		expect(account?.scopes ?? []).toEqual([]) // no capability enabled until toggled on
	})

	test('connect (form) keys the account by the acquired identity', async () => {
		const { caps, accounts } = await setup()
		expect(
			await caps.admin.connect({
				providerId: 'icloud',
				credentials: { username: 'u@me.com', password: 'p' }
			})
		).toEqual({ accountId: 'u@me.com' })
		expect(await accounts.get('u@me.com')).toMatchObject({
			id: 'u@me.com',
			provider: 'icloud',
			creds: { username: 'u@me.com', password: 'p' }
		})
	})

	test('listAccounts derives enablement from scopes + the active-AI selection', async () => {
		const { caps, accounts, activeAi } = await setup()
		await put(accounts, { id: 'g', provider: 'google', creds: {}, scopes: [GMAIL_SCOPE] })
		await put(accounts, { id: 'u@openai', provider: 'chatgpt', creds: { access: 'tok' } })
		await activeAi.set({ accountId: 'u@openai', model: 'default' })
		const list = await caps.admin.listAccounts({})
		expect(list.find((a) => a.accountId === 'g')?.enabled).toEqual(['email'])
		const ai = list.find((a) => a.accountId === 'u@openai')
		expect(ai?.enabled).toEqual(['ai'])
		expect(ai?.config.ai).toEqual({
			model: 'default',
			models: [{ id: 'default', name: 'Default' }]
		})
	})

	// D1/D2 ("one account, many hosts", #290): a host stamps who it is onto every
	// account it projects, so Settings can label which lane an account lives in (#296).
	describe('origin', () => {
		test('every account is stamped with the configured origin', async () => {
			const vol = volume(memStorage())
			const caps = hostAccounts(testProviders(), vol, {
				origin: { kind: 'device', label: 'Fern’s MacBook' }
			})
			await caps.admin.connect({ providerId: 'chatgpt' })
			const [account] = await caps.admin.listAccounts({})
			expect(account?.origin).toEqual({ kind: 'device', label: 'Fern’s MacBook' })
		})

		test('the cloud variant stamps the same way', async () => {
			const vol = volume(memStorage())
			const caps = hostAccounts(testProviders(), vol, { origin: { kind: 'cloud' } })
			await caps.admin.connect({ providerId: 'chatgpt' })
			const [account] = await caps.admin.listAccounts({})
			expect(account?.origin).toEqual({ kind: 'cloud' })
		})

		test('no configured origin leaves AccountInfo.origin undefined', async () => {
			// Today's DO/mac callers, before this field existed — forward compatibility with
			// a reader that defaults an absent origin to 'cloud' (see app-settings).
			const { caps } = await setup()
			await caps.admin.connect({ providerId: 'chatgpt' })
			const [account] = await caps.admin.listAccounts({})
			expect(account?.origin).toBeUndefined()
		})
	})

	test('enabling email widens scope via incremental consent; disabling drops it', async () => {
		const { caps, accounts } = await setup()
		await put(accounts, { id: 'me@gmail.com', provider: 'google', creds: { refresh: 'R' } })
		await caps.admin.setEnabled({
			accountId: 'me@gmail.com',
			capability: 'email',
			enabled: true
		})
		expect((await accounts.get('me@gmail.com'))?.scopes).toContain(GMAIL_SCOPE)
		await caps.admin.setEnabled({
			accountId: 'me@gmail.com',
			capability: 'email',
			enabled: false
		})
		expect((await accounts.get('me@gmail.com'))?.scopes ?? []).not.toContain(GMAIL_SCOPE)
	})

	test('re-enabling a capability whose scope is already granted skips acquisition', async () => {
		const acquire = vi.fn(async ({ scopes }: { scopes: string[] }) => ({
			accountId: 'me@gmail.com',
			creds: { refresh: 'R2', accountId: 'me@gmail.com' },
			scopes
		}))
		const { caps, accounts } = await setup(testProviders({ google: fakeGoogle(acquire) }))
		await put(accounts, {
			id: 'me@gmail.com',
			provider: 'google',
			creds: { refresh: 'R' },
			scopes: [GMAIL_SCOPE]
		})
		await caps.admin.setEnabled({
			accountId: 'me@gmail.com',
			capability: 'email',
			enabled: true
		})
		expect(acquire).not.toHaveBeenCalled()
	})

	test('widened consent landing after a disconnect does not resurrect the account', async () => {
		// The browser flow can take minutes; the write that follows takes the account as it is
		// by then, not as it was when the toggle was clicked.
		const vol = volume(memStorage())
		const accounts = volumeAccountStore(vol)
		await put(accounts, { id: 'me@gmail.com', provider: 'google', creds: { refresh: 'R' } })
		const caps = hostAccounts(
			testProviders({
				google: fakeGoogle(async ({ scopes }) => {
					await accounts.delete('me@gmail.com')
					return { accountId: 'me@gmail.com', creds: { refresh: 'WIDENED' }, scopes }
				})
			}),
			vol
		)
		await caps.admin.setEnabled({
			accountId: 'me@gmail.com',
			capability: 'email',
			enabled: true
		})
		expect(await accounts.get('me@gmail.com')).toBeUndefined()
	})

	test('a form provider capability cannot be soft-disabled (disconnect instead)', async () => {
		const { caps } = await setup()
		await caps.admin.connect({
			providerId: 'icloud',
			credentials: { username: 'u@me.com', password: 'p' }
		})
		await caps.admin.setEnabled({
			accountId: 'u@me.com',
			capability: 'calendar',
			enabled: false
		})
		const list = await caps.admin.listAccounts({})
		expect(list.find((a) => a.accountId === 'u@me.com')?.enabled).toContain('calendar')
	})

	test('ai is single-active: enabling it points the selection, freeing the previous', async () => {
		const { caps, accounts, activeAi } = await setup()
		await put(accounts, { id: 'a1', provider: 'chatgpt', creds: {} })
		await put(accounts, { id: 'a2', provider: 'chatgpt', creds: {} })
		await activeAi.set({ accountId: 'a1' })
		await caps.admin.setEnabled({
			accountId: 'a2',
			capability: 'ai',
			enabled: true,
			config: { model: 'default' }
		})
		expect(await activeAi.get()).toEqual({ accountId: 'a2', model: 'default' })
	})

	test('disconnect removes the account and drops the active-AI pointer', async () => {
		// No builtin AI provider here, so there is no floor: the host is left with no AI.
		const { caps, accounts, activeAi } = await setup([fakeChatgpt()])
		await put(accounts, { id: 'u@openai', provider: 'chatgpt', creds: {} })
		await activeAi.set({ accountId: 'u@openai' })
		await caps.admin.disconnect({ accountId: 'u@openai' })
		expect(await accounts.get('u@openai')).toBeUndefined()
		expect(await activeAi.get()).toBeNull()
		expect(await caps.resolveAi((l) => l.providerId)).toBeNull()
	})
})

// The built-in platform account is DERIVED from the provider registry: a `builtin`
// provider that backs `ai` is the platform's own, one account, no credentials. Absence of
// a file is therefore that account rather than a missing one — which is what lets a fresh
// sign-up (and the volume a destructive reset leaves behind) resolve AI with nothing on
// disk and no seeding step for a republish to race.
describe('the built-in platform account is derived', () => {
	const PRIVATE_FILES = ['/private/accounts/frieren.json', '/private/active-ai.json']

	test('an empty volume already lists and resolves the platform AI — and stays empty', async () => {
		const { caps, vol } = await setup()
		const list = await caps.admin.listAccounts({})
		expect(list).toMatchObject([{ accountId: 'frieren', providerId: 'frieren', enabled: ['ai'] }])
		await expect(caps.resolveAi((l) => l.providerId)).resolves.toBe('frieren')
		// Nothing was written to make either of those true.
		for (const path of PRIVATE_FILES) expect(await vol.exists(path)).toBe(false)
	})

	test('an absent and a dangling selection resolve the same floor', async () => {
		const { caps, activeAi } = await setup()
		const absent = await caps.resolveAi((l) => l.providerId)
		// e.g. a retired account id, or an account connected on another host — the selection
		// lane is host-private, so a pointer can outlive the record it names.
		await activeAi.set({ accountId: 'nobody-here' })
		expect(await caps.resolveAi((l) => l.providerId)).toBe(absent)
		expect(absent).toBe('frieren')
	})

	test('a live user selection overrides the floor, and image follows it', async () => {
		const { caps, accounts, activeAi } = await setup(
			testProviders({
				platform: platformProvider({
					generate: async (_s, p) => `platform:${p}`,
					generateImage: async (prompt) => [{ data: `b64:${prompt}`, mimeType: 'image/png' }]
				})
			})
		)
		// The floor answers text and image together.
		await expect(caps.resolveAi((l) => l.providerId)).resolves.toBe('frieren')
		await expect(
			caps.image.invoke(use('image', 'generateImage', { prompt: 'a red panda' }))
		).resolves.toEqual({ images: [{ data: 'b64:a red panda', mimeType: 'image/png' }] })

		// Selecting the user's own AI takes BOTH over — this provider backs no image engine,
		// so images go with it rather than quietly falling back to the platform's.
		await put(accounts, { id: 'u@openai', provider: 'chatgpt', creds: { access: 'tok' } })
		await activeAi.set({ accountId: 'u@openai' })
		await expect(caps.resolveAi((l) => l.providerId)).resolves.toBe('chatgpt')
		await expect(
			caps.image.invoke(use('image', 'generateImage', { prompt: 'a red panda' }))
		).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE', capability: 'image' })
	})

	test('a selected account whose credentials are unreadable stays listed, but AI falls back', async () => {
		// The key rotated (or was never deployed): the record reads back with `creds: undefined`
		// and mints nothing, so honouring the selection would strand the user with a dead agent.
		// The record itself is untouched — its sealed bytes wait for the restored key.
		const vol = volume(memStorage())
		await put(volumeAccountStore(vol, { secretCodec: aesGcmSecretCodec('old-key') }), {
			id: 'u@openai',
			provider: 'chatgpt',
			creds: { access: 'tok' }
		})
		const sealed = await vol.readFile('/private/accounts/u%40openai.json')
		await volumeActiveAi(vol).set({ accountId: 'u@openai', model: 'gpt' })
		const caps = hostAccounts(testProviders(), vol, { secretCodec: aesGcmSecretCodec('host-key') })

		await expect(caps.resolveAi((l) => l.providerId)).resolves.toBe('frieren')
		const list = await caps.admin.listAccounts({})
		expect(list.find((a) => a.accountId === 'u@openai')?.lastError).toBeTruthy()
		expect(list.find((a) => a.accountId === 'frieren')?.enabled).toContain('ai')
		expect(await vol.readFile('/private/accounts/u%40openai.json')).toEqual(sealed)
		// The dangling selection is left alone too: re-selecting is a click once the key is back.
		expect(await volumeActiveAi(vol).get()).toEqual({ accountId: 'u@openai', model: 'gpt' })
	})

	test('turning a user AI account off, or disconnecting it, lands back on the floor', async () => {
		const { caps, accounts, activeAi } = await setup()
		await put(accounts, { id: 'u@openai', provider: 'chatgpt', creds: { access: 'tok' } })

		await caps.admin.setEnabled({ accountId: 'u@openai', capability: 'ai', enabled: true })
		expect(await activeAi.get()).toEqual({ accountId: 'u@openai' })
		await caps.admin.setEnabled({ accountId: 'u@openai', capability: 'ai', enabled: false })
		await expect(caps.resolveAi((l) => l.providerId)).resolves.toBe('frieren')

		await caps.admin.setEnabled({ accountId: 'u@openai', capability: 'ai', enabled: true })
		await caps.admin.disconnect({ accountId: 'u@openai' })
		await expect(caps.resolveAi((l) => l.providerId)).resolves.toBe('frieren')
	})

	test('the floor has no off state — unchecking it re-selects it, and writes nothing', async () => {
		const { caps, vol } = await setup()
		await caps.admin.setEnabled({ accountId: 'frieren', capability: 'ai', enabled: false })
		await expect(caps.resolveAi((l) => l.providerId)).resolves.toBe('frieren')
		const list = await caps.admin.listAccounts({})
		expect(list.find((a) => a.accountId === 'frieren')?.enabled).toContain('ai')
		expect(await vol.exists('/private/active-ai.json')).toBe(false)
	})

	test('a leftover platform record is superseded, not trusted', async () => {
		// The seeding this replaced wrote `/private/accounts/frieren.json`. Under a rotated key
		// that record reads back broken — which must never be what the platform AI looks like.
		const vol = volume(memStorage())
		await put(volumeAccountStore(vol, { secretCodec: aesGcmSecretCodec('old-key') }), {
			id: 'frieren',
			provider: 'frieren',
			creds: {}
		})
		const caps = hostAccounts(testProviders(), vol, { secretCodec: aesGcmSecretCodec('host-key') })
		const list = await caps.admin.listAccounts({})
		expect(list.filter((a) => a.accountId === 'frieren')).toHaveLength(1)
		expect(list.find((a) => a.accountId === 'frieren')?.lastError).toBeUndefined()
		await expect(caps.resolveAi((l) => l.providerId)).resolves.toBe('frieren')
	})

	test('a host with no builtin AI provider has no floor at all', async () => {
		const { caps } = await setup([fakeGoogle(), icloudProvider()])
		expect(await caps.admin.listAccounts({})).toEqual([])
		expect(await caps.resolveAi((l) => l.providerId)).toBeNull()
	})
})

describe('use-facet dispatch', () => {
	test('image is UNAVAILABLE when the active AI provider has no image binding', async () => {
		// The default platform provider carries no image engine; chatgpt never does. Either
		// way the active account decides — image swaps (or vanishes) with the AI switch.
		const { caps } = await setup()
		await expect(
			caps.image.invoke(use('image', 'generateImage', { prompt: 'a red panda' }))
		).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE', capability: 'image' })
	})

	test('email.listUnread fans out across backing accounts, each stamped', async () => {
		// Each account mints its own bearer from its own refresh token (`<refresh>-tok`), and
		// Gmail returns one unread keyed by that bearer — so each account yields a distinct
		// message and the fan-out is visible in the ids.
		vi.stubGlobal(
			'fetch',
			async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
				if (url === 'https://oauth2.googleapis.com/token') {
					const refresh = new URLSearchParams(init?.body ?? '').get('refresh_token')
					return json({ access_token: `${refresh}-tok`, expires_in: 3600 })
				}
				const token = init?.headers?.authorization?.replace('Bearer ', '')
				if (url.includes('/messages?q=is:unread'))
					return json({ messages: [{ id: `${token}-m1` }] })
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
			}
		)
		const { caps, accounts } = await setup()
		await put(accounts, {
			id: 'g1',
			provider: 'google',
			creds: { refresh: 't1', accountId: 'g1' },
			scopes: [GMAIL_SCOPE]
		})
		await put(accounts, {
			id: 'g2',
			provider: 'google',
			creds: { refresh: 't2', accountId: 'g2' },
			scopes: [GMAIL_SCOPE]
		})
		const unread = (await caps.email.invoke(use('email', 'listUnread', {}))) as {
			id: string
			accountId: string
		}[]
		expect(unread.map((m) => [m.accountId, m.id]).sort()).toEqual([
			['g1', 't1-tok-m1'],
			['g2', 't2-tok-m1']
		])
	})

	// A capability call is bound over a SNAPSHOT of the account, and a provider whose token
	// refreshes mid-call writes back when the exchange lands — which can be long after. These
	// three pin the writeback's compare-and-set: it replaces only the value this client last saw.
	describe('credential writeback', () => {
		// A Google-shaped provider whose one email call does `duringCall` (the race), then writes
		// back rotated creds — exactly the ordering a mid-call token refresh produces.
		function persistingGoogle(duringCall: () => Promise<void>, rotated: unknown): Provider {
			return {
				...fakeGoogle(),
				capabilities: {
					email: {
						bind: (account) => ({
							listUnread: async () => {
								await duringCall()
								await account.persist(rotated)
								return []
							},
							readDetail: async () => {
								throw new Error('not used')
							},
							markRead: async () => ({ success: true })
						})
					}
				}
			}
		}

		test('one that lost the race to disconnect does not resurrect the account', async () => {
			// Writing here would bring the credential back after a disconnect that already
			// reported success.
			const { caps, accounts } = await setup(
				testProviders({
					google: persistingGoogle(() => caps.admin.disconnect({ accountId: 'g1' }), {
						refresh: 'rotated'
					})
				})
			)
			await put(accounts, { id: 'g1', provider: 'google', creds: { refresh: 'R' } })
			await caps.email.invoke(use('email', 'listUnread', {}))
			expect(await accounts.get('g1')).toBeUndefined()
		})

		test('one superseded by a newer grant is dropped, scopes and all', async () => {
			// Incremental consent (setEnabled) and a re-connect both replace the whole grant while
			// a refresh is in flight. Overwriting it with the older refresh result is the lost
			// update that leaves the user re-connecting.
			const vol = volume(memStorage())
			const accounts = volumeAccountStore(vol)
			await put(accounts, { id: 'g1', provider: 'google', creds: { refresh: 'R' } })
			const caps = hostAccounts(
				testProviders({
					google: persistingGoogle(
						() =>
							put(accounts, {
								id: 'g1',
								provider: 'google',
								creds: { refresh: 'NEWLY-CONSENTED' },
								scopes: [GMAIL_SCOPE]
							}),
						{ refresh: 'rotated-from-the-old-grant' }
					)
				}),
				vol
			)
			await caps.email.invoke(use('email', 'listUnread', {}))
			expect(await accounts.get('g1')).toMatchObject({
				creds: { refresh: 'NEWLY-CONSENTED' },
				scopes: [GMAIL_SCOPE]
			})
		})

		test('successive rotations from one client all land', async () => {
			// The compare-and-set must not be a one-shot: pi-ai's Codex store rotates repeatedly
			// through the same lease, and every rotation has to reach the record.
			const { caps, accounts, activeAi } = await setup()
			await put(accounts, { id: 'u@openai', provider: 'chatgpt', creds: { access: 'tok' } })
			await activeAi.set({ accountId: 'u@openai' })
			await caps.resolveAi(async (l) => {
				await l.persist({ access: 'r1' })
				await l.persist({ access: 'r2' })
			})
			expect((await accounts.get('u@openai'))?.creds).toEqual({ access: 'r2' })
		})
	})

	test('a use facet with no backing account is UNAVAILABLE', async () => {
		const { caps } = await setup()
		await expect(
			caps.calendar.invoke(use('calendar', 'listToday', { timezone: 'UTC' }))
		).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
	})
})

// `resolveAi` is the account lease the text `ai` capability is built on (host-owned, not
// an accounts capability). It resolves the active AI — the SAME answer the admin
// projection and `image` read — into a caller-minted backend, forwarding the selected
// model and a `persist` that writes rotated credentials back to the shared account.
describe('resolveAi', () => {
	test('leases the active selection with its model + provider to the caller', async () => {
		const { caps, accounts, activeAi } = await setup()
		await put(accounts, { id: 'u@openai', provider: 'chatgpt', creds: { access: 'tok' } })
		await activeAi.set({ accountId: 'u@openai', model: 'default' })
		await expect(
			caps.resolveAi((l) => ({ creds: l.creds, config: l.config, providerId: l.providerId }))
		).resolves.toEqual({
			creds: { access: 'tok' },
			config: { model: 'default' },
			providerId: 'chatgpt'
		})
	})

	test('persist writes a rotated credential back to the shared account', async () => {
		const { caps, accounts, activeAi } = await setup()
		await put(accounts, { id: 'u@openai', provider: 'chatgpt', creds: { access: 'tok' } })
		await activeAi.set({ accountId: 'u@openai' })
		await caps.resolveAi((l) => l.persist({ access: 'rotated' }))
		expect((await accounts.get('u@openai'))?.creds).toEqual({ access: 'rotated' })
	})

	test('persist after a disconnect does not resurrect the account', async () => {
		// Same rule as the use facets: the lease holds a snapshot, and a token refresh landing
		// after the account was disconnected must not write the credential back.
		const { caps, accounts, activeAi } = await setup()
		await put(accounts, { id: 'u@openai', provider: 'chatgpt', creds: { access: 'tok' } })
		await activeAi.set({ accountId: 'u@openai' })
		await caps.resolveAi(async (l) => {
			await accounts.delete('u@openai')
			await l.persist({ access: 'rotated' })
		})
		expect(await accounts.get('u@openai')).toBeUndefined()
	})

	test('the floor leases no model, so the platform picks its own', async () => {
		const { caps } = await setup()
		await expect(caps.resolveAi((l) => l.config)).resolves.toEqual({})
	})
})

// Encryption at rest is one codec for the ONE store this module builds, so there is no
// second entry point it could be missing from. These pin the wiring, not the crypto (see
// secret-codec.test.ts for that).
describe('secretCodec wiring', () => {
	const codec = aesGcmSecretCodec('host-key')

	test('what the admin surface writes sealed, the AI lease still reads', async () => {
		const vol = volume(memStorage())
		const caps = hostAccounts(testProviders(), vol, { secretCodec: codec })
		await caps.admin.connect({ providerId: 'chatgpt' })
		await caps.admin.setEnabled({ accountId: 'u@openai', capability: 'ai', enabled: true })
		const raw = new TextDecoder().decode(await vol.readFile('/private/accounts/u%40openai.json'))
		expect(raw).not.toContain('tok')
		await expect(caps.resolveAi((l) => l.creds)).resolves.toEqual({ access: 'tok' })
	})

	test('a record this host cannot decrypt lists with an error and is unusable', async () => {
		// The rotated/missing-key path, end to end: Settings still renders the account (so
		// the user can re-connect it) and a credential-using call reports UNAVAILABLE rather
		// than leaking a decrypt exception.
		const vol = volume(memStorage())
		await put(volumeAccountStore(vol, { secretCodec: aesGcmSecretCodec('old-key') }), {
			id: 'me@gmail.com',
			provider: 'google',
			creds: { refresh: 'r' },
			scopes: [GMAIL_SCOPE]
		})
		const caps = hostAccounts(testProviders(), vol, { secretCodec: codec })
		const list = await caps.admin.listAccounts({})
		expect(list.find((a) => a.accountId === 'me@gmail.com')?.lastError).toBeTruthy()
		await expect(caps.email.invoke(use('email', 'listUnread', { limit: 1 }))).rejects.toMatchObject(
			{ code: 'CAPABILITY_UNAVAILABLE' }
		)
	})

	// The sweep exists because `decode` deliberately passes a non-envelope through, so nothing
	// else ever rewrites a credential that does not rotate (an iCloud app-specific password is
	// written exactly once, at connect). It is best effort: no caller waits on it, and no
	// caller can see whether it ran.
	describe('sealing what is already on disk', () => {
		const sealedRecord = async (vol: Volume) =>
			new TextDecoder().decode(await vol.readFile('/private/accounts/u%40me.com.json'))

		test('a plaintext record is sealed without any caller asking', async () => {
			const vol = volume(memStorage())
			await put(volumeAccountStore(vol), { id: 'u@me.com', provider: 'icloud', creds: { p: 'PW' } })
			hostAccounts(testProviders(), vol, { secretCodec: codec })
			await until(async () => expect(await sealedRecord(vol)).not.toContain('PW'))
			expect(await volumeAccountStore(vol, { secretCodec: codec }).get('u@me.com')).toMatchObject({
				creds: { p: 'PW' }
			})
		})

		test('with no key there is nothing to seal with, so the record is left as it was', async () => {
			const vol = volume(memStorage())
			await put(volumeAccountStore(vol), { id: 'u@me.com', provider: 'icloud', creds: { p: 'PW' } })
			const before = await sealedRecord(vol)
			hostAccounts(testProviders(), vol)
			await new Promise((r) => setTimeout(r, 10))
			expect(await sealedRecord(vol)).toEqual(before)
		})

		test('a sweep that fails blocks nothing and retries on a later account entry', async () => {
			// A locked Keychain must not cost the platform AI, and must not be memoised as a
			// permanent verdict — the keychain may be open by the next time anyone asks.
			vi.spyOn(console, 'warn').mockImplementation(() => {})
			const vol = volume(memStorage())
			await put(volumeAccountStore(vol), { id: 'u@me.com', provider: 'icloud', creds: { p: 'PW' } })
			let locked = true
			const flaky: SecretCodec = {
				encode: (creds, id) => {
					if (locked) throw new Error('keychain: locked')
					return codec.encode(creds, id)
				},
				decode: (raw, id) => codec.decode(raw, id)
			}
			const caps = hostAccounts(testProviders(), vol, { secretCodec: flaky })

			// The platform AI answers while the sweep is failing, and the credential survives.
			await expect(caps.resolveAi((l) => l.providerId)).resolves.toBe('frieren')
			expect(await sealedRecord(vol)).toContain('PW')

			locked = false
			await until(async () => {
				await caps.admin.listAccounts({})
				expect(await sealedRecord(vol)).not.toContain('PW')
			})
		})
	})
})
