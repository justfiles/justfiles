import { aesGcmSecretCodec, hostAccounts } from '@justfiles/app/accounts/host'
import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { afterEach, expect, test, vi } from 'vitest'
import { chatgptAccount } from './chatgpt.ts'

const jwt = (suffix = '') =>
	`e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account' } })).toString('base64url')}.${suffix}`
afterEach(() => vi.unstubAllGlobals())

async function setup(expired = false) {
	const calls: { url: string; init?: RequestInit }[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = String(input)
			calls.push({ url, init })
			if (url.endsWith('/deviceauth/usercode'))
				return Response.json({
					device_auth_id: 'device-secret',
					user_code: 'USER-CODE',
					interval: 0
				})
			if (url.endsWith('/deviceauth/token'))
				return Response.json({
					authorization_code: 'code-secret',
					code_verifier: 'verifier-secret'
				})
			if (url.endsWith('/oauth/token')) {
				const refresh = String(init?.body).includes('refresh_token')
				return Response.json({
					access_token: jwt(refresh ? 'new' : 'old'),
					refresh_token: refresh ? 'rotated-secret' : 'refresh-secret',
					expires_in: expired && !refresh ? 0 : 3600
				})
			}
			return new Response(
				'data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
				{ headers: { 'content-type': 'text/event-stream' } }
			)
		})
	)
	const fs = volume(memStore())
	const chatgpt = chatgptAccount({ url: 'https://proxy.example', key: 'proxy-secret' })
	const accounts = hostAccounts([chatgpt.provider], fs, {
		secretCodec: aesGcmSecretCodec('test-encryption-secret')
	})
	const ref = { providerId: 'chatgpt', operationId: 'test' }
	await accounts.admin.beginConnect(ref)
	await vi.waitFor(async () =>
		expect((await accounts.admin.readConnect(ref)).status).toBe('connected')
	)
	await accounts.admin.setEnabled({ accountId: 'chatgpt:account', capability: 'ai', enabled: true })
	return { calls, fs, chatgpt, accounts }
}

test('device sign-in persists encrypted tokens and inference uses only the fixed proxy', async () => {
	const { calls, fs, chatgpt, accounts } = await setup()
	const raw = new TextDecoder().decode(
		await fs.readFile('/private/accounts/chatgpt%3Aaccount.json')
	)
	expect(raw).not.toContain('refresh-secret')
	expect(raw).not.toContain(jwt('old'))
	const backend = (await accounts.resolveAi(chatgpt.backend))!
	const answer = await backend.completeFn(backend.model, {
		messages: [{ role: 'user', content: 'hello', timestamp: 1 }]
	})
	expect(answer.stopReason).toBe('stop')
	const request = calls.find((c) => c.url.startsWith('https://proxy.example'))!
	expect(request.url).toBe('https://proxy.example/codex/responses')
	const headers = new Headers(request.init?.headers)
	expect(headers.get('authorization')).toBe(`Bearer ${jwt('old')}`)
	expect(headers.get('chatgpt-account-id')).toBe('account')
	expect(headers.get('x-proxy-key')).toBe('proxy-secret')
	expect(JSON.stringify(await accounts.admin.listAccounts({}))).not.toContain('secret')
})

test('concurrent backends refresh once and keep the rotated credential in the same store', async () => {
	const { calls, chatgpt, accounts } = await setup(true)
	const a = (await accounts.resolveAi(chatgpt.backend))!
	const b = (await accounts.resolveAi(chatgpt.backend))!
	const context = { messages: [{ role: 'user' as const, content: 'hello', timestamp: 1 }] }
	const results = await Promise.all([
		a.completeFn(a.model, context),
		b.completeFn(b.model, context)
	])
	expect(results.map((r) => r.stopReason)).toEqual(['stop', 'stop'])
	expect(
		calls.filter(
			(c) => c.url.endsWith('/oauth/token') && String(c.init?.body).includes('refresh_token')
		)
	).toHaveLength(1)
	expect(
		calls
			.filter((c) => c.url.startsWith('https://proxy.example'))
			.map((c) => new Headers(c.init?.headers).get('authorization'))
	).toEqual([`Bearer ${jwt('new')}`, `Bearer ${jwt('new')}`])
})

test('a retired or unknown model fails without choosing another backend', async () => {
	const { chatgpt, accounts, calls } = await setup()
	await accounts.admin.setEnabled({
		accountId: 'chatgpt:account',
		capability: 'ai',
		enabled: true,
		config: { model: 'not-a-model' }
	})
	await expect(accounts.resolveAi(chatgpt.backend)).rejects.toThrow('Choose another model')
	expect(calls.filter((c) => c.url.startsWith('https://proxy.example'))).toHaveLength(0)
})

test('refresh failure preserves the selected account and never calls inference', async () => {
	const { chatgpt, accounts } = await setup(true)
	const backend = (await accounts.resolveAi(chatgpt.backend))!
	const fetch = vi.fn(async () => new Response('invalid_grant', { status: 400 }))
	vi.stubGlobal('fetch', fetch)
	const result = await backend.completeFn(backend.model, { messages: [] })
	expect(result.stopReason).toBe('error')
	expect(result.errorMessage).toContain('OAuth refresh failed')
	expect(fetch).toHaveBeenCalledTimes(1)
	expect((await accounts.admin.listAccounts({}))[0]).toMatchObject({
		accountId: 'chatgpt:account',
		enabled: ['ai']
	})
})

test('browser sign-in validates state and PKCE, then stores tokens only in the cloud', async () => {
	const { accounts, calls, fs } = await setup()
	calls.length = 0
	const ref = { providerId: 'chatgpt', operationId: 'browser' }
	await accounts.admin.beginConnect({ ...ref, method: 'browser' })
	let url!: URL
	await vi.waitFor(async () => {
		const state = await accounts.admin.readConnect(ref)
		expect(state).toMatchObject({
			status: 'pending',
			prompt: { verificationUrl: expect.any(String) }
		})
		if (state.status === 'pending' && state.prompt) url = new URL(state.prompt.verificationUrl)
	})
	expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize')
	expect(url.searchParams.get('code_challenge_method')).toBe('S256')
	const callback = new URL(url.searchParams.get('redirect_uri')!)
	callback.search = new URLSearchParams({ code: 'one-time-code', state: 'wrong-state' }).toString()
	await expect(
		accounts.admin.completeConnect({ ...ref, callbackUrl: callback.href })
	).rejects.toThrow()
	expect(calls).toHaveLength(0)
	callback.searchParams.set('state', url.searchParams.get('state')!)
	await expect(
		accounts.admin.completeConnect({
			...ref,
			callbackUrl: callback.href.replace('localhost:1455', 'attacker.example')
		})
	).rejects.toThrow()
	expect(calls).toHaveLength(0)
	const result = await accounts.admin.completeConnect({ ...ref, callbackUrl: callback.href })
	expect(result).toMatchObject({ status: 'connected', accountId: 'chatgpt:account' })
	expect(calls).toHaveLength(1)
	const exchange = new URLSearchParams(String(calls[0]!.init?.body))
	expect(exchange.get('code')).toBe('one-time-code')
	expect(exchange.get('redirect_uri')).toBe('http://localhost:1455/auth/callback')
	const challenge = Buffer.from(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(exchange.get('code_verifier')!))
	).toString('base64url')
	expect(challenge).toBe(url.searchParams.get('code_challenge'))
	await accounts.admin.completeConnect({ ...ref, callbackUrl: callback.href })
	expect(calls).toHaveLength(1)
	const visible = JSON.stringify([
		result,
		await accounts.admin.listAccounts({}),
		await fs.readFile('/private/accounts/chatgpt%3Aaccount.json')
	])
	for (const secret of ['refresh-secret', jwt('old'), exchange.get('code_verifier')!])
		expect(visible).not.toContain(secret)
})

test.each([
	'cancel',
	'deny'
] as const)('%s browser sign-in never exchanges a credential', async (action) => {
	const { accounts, calls } = await setup()
	calls.length = 0
	const ref = { providerId: 'chatgpt', operationId: 'browser' }
	await accounts.admin.beginConnect({ ...ref, method: 'browser' })
	let url!: URL
	await vi.waitFor(async () => {
		const state = await accounts.admin.readConnect(ref)
		expect(state).toMatchObject({ status: 'pending', prompt: expect.any(Object) })
		if (state.status === 'pending' && state.prompt) url = new URL(state.prompt.verificationUrl)
	})
	const callback = new URL(url.searchParams.get('redirect_uri')!)
	callback.search = new URLSearchParams({
		state: url.searchParams.get('state')!,
		...(action === 'deny' ? { error: 'access_denied' } : { code: 'late-code' })
	}).toString()
	if (action === 'cancel') await accounts.admin.cancelConnect(ref)
	expect(
		await accounts.admin.completeConnect({ ...ref, callbackUrl: callback.href })
	).toMatchObject({ status: action === 'cancel' ? 'cancelled' : 'failed' })
	expect(calls).toHaveLength(0)
})
