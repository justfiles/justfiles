import { memStorage, volume } from '@justfiles/fs'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { CapabilityCall } from '../types.ts'
import { volumeAccountStore } from './account.ts'
import { volumeActiveAi } from './active-ai.ts'
import {
	accountsCapabilities,
	aesGcmSecretCodec,
	ensureAccount,
	resolveAiAccount,
	sealAccounts
} from './host.ts'
import type { Auth, Provider } from './provider.ts'
import { GMAIL_SCOPE, googleProvider } from './providers/google.ts'
import { icloudProvider } from './providers/icloud.ts'
import { platformProvider } from './providers/platform.ts'

// The credential-bearing stores are internal, so tests drive the facets through
// `accountsCapabilities` over a real in-memory Volume. State the admin impl can't
// express (pre-granted scopes, a specific active selection) is written straight to the
// account store / active-AI pointer — the same Volume the capabilities read.
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

async function setup(providers: Provider[] = testProviders()) {
	const vol = volume(memStorage())
	const caps = accountsCapabilities(providers, vol)
	return { caps, vol, accounts: volumeAccountStore(vol), activeAi: volumeActiveAi(vol) }
}

function use(capability: string, method: string, input: unknown): CapabilityCall {
	return { appId: 'app.any', capability, method, args: [input], scopes: [] }
}
function json(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200 })
}

afterEach(() => vi.unstubAllGlobals())

describe('accounts admin impl', () => {
	test('listProviders projects the registry', async () => {
		const { caps } = await setup()
		const list = await caps.accounts.listProviders({})
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
		expect(await caps.accounts.connect({ providerId: 'google' })).toEqual({
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
			await caps.accounts.connect({
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
		await accounts.put({ id: 'g', provider: 'google', creds: {}, scopes: [GMAIL_SCOPE] })
		await accounts.put({ id: 'u@openai', provider: 'chatgpt', creds: { access: 'tok' } })
		await activeAi.set({ accountId: 'u@openai', model: 'default' })
		const list = await caps.accounts.listAccounts({})
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
			const caps = accountsCapabilities(testProviders(), vol, {
				origin: { kind: 'device', label: 'Fern’s MacBook' }
			})
			await caps.accounts.connect({ providerId: 'chatgpt' })
			const [account] = await caps.accounts.listAccounts({})
			expect(account?.origin).toEqual({ kind: 'device', label: 'Fern’s MacBook' })
		})

		test('the cloud variant stamps the same way', async () => {
			const vol = volume(memStorage())
			const caps = accountsCapabilities(testProviders(), vol, { origin: { kind: 'cloud' } })
			await caps.accounts.connect({ providerId: 'chatgpt' })
			const [account] = await caps.accounts.listAccounts({})
			expect(account?.origin).toEqual({ kind: 'cloud' })
		})

		test('no configured origin leaves AccountInfo.origin undefined', async () => {
			// Today's DO/mac callers, before this field existed — forward compatibility with
			// a reader that defaults an absent origin to 'cloud' (see app-settings).
			const { caps } = await setup()
			await caps.accounts.connect({ providerId: 'chatgpt' })
			const [account] = await caps.accounts.listAccounts({})
			expect(account?.origin).toBeUndefined()
		})
	})

	test('enabling email widens scope via incremental consent; disabling drops it', async () => {
		const { caps, accounts } = await setup()
		await accounts.put({ id: 'me@gmail.com', provider: 'google', creds: { refresh: 'R' } })
		await caps.accounts.setEnabled({
			accountId: 'me@gmail.com',
			capability: 'email',
			enabled: true
		})
		expect((await accounts.get('me@gmail.com'))?.scopes).toContain(GMAIL_SCOPE)
		await caps.accounts.setEnabled({
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
		await accounts.put({
			id: 'me@gmail.com',
			provider: 'google',
			creds: { refresh: 'R' },
			scopes: [GMAIL_SCOPE]
		})
		await caps.accounts.setEnabled({
			accountId: 'me@gmail.com',
			capability: 'email',
			enabled: true
		})
		expect(acquire).not.toHaveBeenCalled()
	})

	test('a form provider capability cannot be soft-disabled (disconnect instead)', async () => {
		const { caps } = await setup()
		await caps.accounts.connect({
			providerId: 'icloud',
			credentials: { username: 'u@me.com', password: 'p' }
		})
		await caps.accounts.setEnabled({
			accountId: 'u@me.com',
			capability: 'calendar',
			enabled: false
		})
		const list = await caps.accounts.listAccounts({})
		expect(list.find((a) => a.accountId === 'u@me.com')?.enabled).toContain('calendar')
	})

	test('ai is single-active: enabling it points the selection, freeing the previous', async () => {
		const { caps, accounts, activeAi } = await setup()
		await accounts.put({ id: 'a1', provider: 'chatgpt', creds: {} })
		await accounts.put({ id: 'a2', provider: 'chatgpt', creds: {} })
		await activeAi.set({ accountId: 'a1' })
		await caps.accounts.setEnabled({
			accountId: 'a2',
			capability: 'ai',
			enabled: true,
			config: { model: 'default' }
		})
		expect(await activeAi.get()).toEqual({ accountId: 'a2', model: 'default' })
	})

	test('disconnect removes the account and clears the active-AI pointer', async () => {
		// No builtin AI account on this volume, so there is no floor to fall back to.
		const { caps, accounts, activeAi } = await setup()
		await accounts.put({ id: 'u@openai', provider: 'chatgpt', creds: {} })
		await activeAi.set({ accountId: 'u@openai' })
		await caps.accounts.disconnect({ accountId: 'u@openai' })
		expect(await accounts.get('u@openai')).toBeUndefined()
		expect(await activeAi.get()).toBeNull()
	})

	// The builtin AI needs no credentials, so it is the floor: a user's own AI account takes
	// over while it is selected, and everything that would clear the selection lands back on
	// the builtin instead of leaving the user with no AI at all.
	describe('the builtin AI is the floor', () => {
		const withFloor = async () => {
			const s = await setup()
			await s.accounts.put({ id: 'frieren', provider: 'frieren', creds: {} })
			await s.activeAi.set({ accountId: 'frieren' })
			await s.accounts.put({ id: 'u@openai', provider: 'chatgpt', creds: { access: 'tok' } })
			return s
		}

		test('turning a user AI account off hands the selection back to the builtin', async () => {
			const { caps, activeAi } = await withFloor()
			await caps.accounts.setEnabled({ accountId: 'u@openai', capability: 'ai', enabled: true })
			expect(await activeAi.get()).toEqual({ accountId: 'u@openai' })
			await caps.accounts.setEnabled({ accountId: 'u@openai', capability: 'ai', enabled: false })
			expect(await activeAi.get()).toEqual({ accountId: 'frieren' })
		})

		test('disconnecting the active user AI account falls back to the builtin', async () => {
			const { caps, activeAi } = await withFloor()
			await caps.accounts.setEnabled({ accountId: 'u@openai', capability: 'ai', enabled: true })
			await caps.accounts.disconnect({ accountId: 'u@openai' })
			expect(await activeAi.get()).toEqual({ accountId: 'frieren' })
		})

		test('the builtin has no off state — unchecking it re-selects it', async () => {
			const { caps, activeAi } = await withFloor()
			await caps.accounts.setEnabled({ accountId: 'frieren', capability: 'ai', enabled: false })
			expect(await activeAi.get()).toEqual({ accountId: 'frieren' })
			const list = await caps.accounts.listAccounts({})
			expect(list.find((a) => a.accountId === 'frieren')?.enabled).toContain('ai')
		})
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
		await accounts.put({
			id: 'g1',
			provider: 'google',
			creds: { refresh: 't1', accountId: 'g1' },
			scopes: [GMAIL_SCOPE]
		})
		await accounts.put({
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
					google: persistingGoogle(() => caps.accounts.disconnect({ accountId: 'g1' }), {
						refresh: 'rotated'
					})
				})
			)
			await accounts.put({ id: 'g1', provider: 'google', creds: { refresh: 'R' } })
			await caps.email.invoke(use('email', 'listUnread', {}))
			expect(await accounts.get('g1')).toBeUndefined()
		})

		test('one superseded by a newer grant is dropped, scopes and all', async () => {
			// Incremental consent (setEnabled) and a re-connect both replace the whole grant while
			// a refresh is in flight. Overwriting it with the older refresh result is the lost
			// update that leaves the user re-connecting.
			const vol = volume(memStorage())
			const accounts = volumeAccountStore(vol)
			await accounts.put({ id: 'g1', provider: 'google', creds: { refresh: 'R' } })
			const caps = accountsCapabilities(
				testProviders({
					google: persistingGoogle(
						() =>
							accounts.put({
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
			const vol = volume(memStorage())
			const accounts = volumeAccountStore(vol)
			await accounts.put({ id: 'u@openai', provider: 'chatgpt', creds: { access: 'tok' } })
			await volumeActiveAi(vol).set({ accountId: 'u@openai' })
			await resolveAiAccount(vol, async (l) => {
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

	test('persist after a disconnect does not resurrect the account', async () => {
		// Same rule as the use facets: the lease holds a snapshot, and a token refresh landing
		// after the account was disconnected must not write the credential back.
		const vol = volume(memStorage())
		const accounts = volumeAccountStore(vol)
		const activeAi = volumeActiveAi(vol)
		await accounts.put({ id: 'u@openai', provider: 'chatgpt', creds: { access: 'tok' } })
		await activeAi.set({ accountId: 'u@openai' })
		await resolveAiAccount(vol, async (l) => {
			await accounts.delete('u@openai')
			await l.persist({ access: 'rotated' })
		})
		expect(await accounts.get('u@openai')).toBeUndefined()
	})

	test('is null with no active selection', async () => {
		const vol = volume(memStorage())
		expect(await resolveAiAccount(vol, () => 'x')).toBeNull()
	})
})

// The platform AI is the floor: a signed-in user must always end up with a backend, so
// this seeds the account AND claims the single-active selection whenever nothing live
// answers. The selection rides synced `/system` while the accounts it names live on
// host-only `/private`, so a pointer can outlive its account — that is a leftover, not a
// choice, and honouring it would leave the agent with no backend until the user toggled AI
// on by hand in Settings.
describe('ensureAccount', () => {
	const platform = { accountId: 'frieren', providerId: 'frieren', enabled: ['ai' as const] }

	test('a fresh volume gets the account and the active-AI selection', async () => {
		const vol = volume(memStorage())
		await ensureAccount(vol, platform)
		expect(await volumeAccountStore(vol).get('frieren')).toMatchObject({ provider: 'frieren' })
		expect(await volumeActiveAi(vol).get()).toEqual({ accountId: 'frieren' })
	})

	test('a selection naming an account this host does not have is claimed, not honoured', async () => {
		const vol = volume(memStorage())
		const accounts = volumeAccountStore(vol)
		await accounts.put({ id: 'frieren', provider: 'frieren', creds: {} })
		// e.g. a retired account id, or an account connected on another host.
		await volumeActiveAi(vol).set({ accountId: 'spud' })
		await ensureAccount(vol, platform)
		expect(await volumeActiveAi(vol).get()).toEqual({ accountId: 'frieren' })
		await expect(resolveAiAccount(vol, (l) => l.providerId)).resolves.toBe('frieren')
	})

	test('another live account keeps the selection, model and all', async () => {
		const vol = volume(memStorage())
		const accounts = volumeAccountStore(vol)
		await accounts.put({ id: 'u@openai', provider: 'chatgpt', creds: { access: 'tok' } })
		await volumeActiveAi(vol).set({ accountId: 'u@openai', model: 'gpt' })
		await ensureAccount(vol, platform)
		expect(await volumeActiveAi(vol).get()).toEqual({ accountId: 'u@openai', model: 'gpt' })
	})

	test('AI is never off: the floor takes the selection back after a switch away', async () => {
		// The user's own account takes over while it is selected; unchecking it (or losing it)
		// lands back on the platform AI rather than on "no AI at all".
		const vol = volume(memStorage())
		const caps = accountsCapabilities(testProviders(), vol)
		await ensureAccount(vol, platform)
		await volumeAccountStore(vol).put({ id: 'u@openai', provider: 'chatgpt', creds: {} })
		await caps.accounts.setEnabled({ accountId: 'u@openai', capability: 'ai', enabled: true })
		await caps.accounts.setEnabled({ accountId: 'u@openai', capability: 'ai', enabled: false })
		expect(await volumeActiveAi(vol).get()).toEqual({ accountId: 'frieren' })
		await ensureAccount(vol, platform)
		await expect(resolveAiAccount(vol, (l) => l.providerId)).resolves.toBe('frieren')
	})

	test('a selection whose credentials this host cannot read is claimed too', async () => {
		// The key rotated (or is not deployed yet), so the selected account reads back with
		// `creds: undefined` and mints nothing. Existence is not enough: `resolveAiAccount` would
		// hand back no backend, i.e. a dead agent, so the floor takes over. The record itself is
		// left alone — its sealed bytes wait for the restored key, and re-selecting it is a click.
		const vol = volume(memStorage())
		const codec = aesGcmSecretCodec('host-key')
		await volumeAccountStore(vol, { secretCodec: aesGcmSecretCodec('old-key') }).put({
			id: 'u@openai',
			provider: 'chatgpt',
			creds: { access: 'tok' }
		})
		const sealed = await vol.readFile('/private/accounts/u%40openai.json')
		await volumeActiveAi(vol).set({ accountId: 'u@openai', model: 'gpt' })

		await ensureAccount(vol, platform, { secretCodec: codec })

		expect(await volumeActiveAi(vol).get()).toEqual({ accountId: 'frieren' })
		await expect(resolveAiAccount(vol, (l) => l.providerId, { secretCodec: codec })).resolves.toBe(
			'frieren'
		)
		expect(await vol.readFile('/private/accounts/u%40openai.json')).toEqual(sealed)
	})
})

// Encryption at rest is one codec shared by EVERY entry point that builds the store: a
// codec on some but not all of them means half the reads can't decrypt, so these tests
// pin the wiring, not the crypto (see secret-codec.test.ts for that).
describe('secretCodec wiring', () => {
	const codec = aesGcmSecretCodec('host-key')

	test('one codec across accountsCapabilities, ensureAccount, resolveAiAccount', async () => {
		const vol = volume(memStorage())
		const caps = accountsCapabilities(testProviders(), vol, { secretCodec: codec })
		await caps.accounts.connect({ providerId: 'chatgpt' })
		await caps.accounts.setEnabled({ accountId: 'u@openai', capability: 'ai', enabled: true })
		// On disk the creds are sealed; the facet that needs them still reads them.
		const raw = new TextDecoder().decode(await vol.readFile('/private/accounts/u%40openai.json'))
		expect(raw).not.toContain('tok')
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

	test('sealAccounts is a no-op without a key, and seals with one', async () => {
		const vol = volume(memStorage())
		await volumeAccountStore(vol).put({ id: 'u@me.com', provider: 'icloud', creds: { p: 'PW' } })
		const path = '/private/accounts/u%40me.com.json'
		const clear = await vol.readFile(path)

		// No key ⇒ nothing to seal with, so the record is left exactly as it was.
		await sealAccounts(vol)
		expect(await vol.readFile(path)).toEqual(clear)

		await sealAccounts(vol, { secretCodec: codec })
		expect(new TextDecoder().decode(await vol.readFile(path))).not.toContain('PW')
		expect(await volumeAccountStore(vol, { secretCodec: codec }).get('u@me.com')).toMatchObject({
			creds: { p: 'PW' }
		})
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
		const caps = accountsCapabilities(testProviders(), vol, { secretCodec: codec })
		const list = await caps.accounts.listAccounts({})
		expect(list).toMatchObject([{ accountId: 'me@gmail.com', providerId: 'google' }])
		expect(list[0].lastError).toBeTruthy()
		await expect(caps.email.invoke(use('email', 'listUnread', { limit: 1 }))).rejects.toMatchObject(
			{ code: 'CAPABILITY_UNAVAILABLE' }
		)
	})
})
