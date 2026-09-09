import { createServer } from 'node:http'
import { hostAccounts } from '@justfiles/app/accounts/host'
import { icloudProvider, type Provider, platformProvider } from '@justfiles/app/accounts/providers'
import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { createSettingsHost } from '@justfiles/ui/settings/host'
import { serveSettings } from '@justfiles/ui/settings/http'
import { afterEach, expect, test, vi } from 'vitest'
import { cloudAccounts } from './cloud-accounts.ts'

const chatgpt: Provider = {
	id: 'chatgpt',
	name: 'ChatGPT',
	auth: {
		ui: { kind: 'interactive' },
		acquire: async () => ({ accountId: 'chatgpt:person', creds: { access: 'private-token' } })
	},
	capabilities: { ai: { bind: () => ({ generateText: async () => ({ text: 'hello' }) }) } }
}
const liveFetch = globalThis.fetch
afterEach(() => vi.unstubAllGlobals())

function setup(provider = chatgpt) {
	const local = hostAccounts([icloudProvider()], volume(memStore()), {
		origin: { kind: 'device', label: 'Mac' }
	}).admin
	const cloud = hostAccounts(
		[
			provider,
			icloudProvider(),
			platformProvider({ generate: async () => '', generateImage: async () => [] })
		],
		volume(memStore())
	).admin
	const server = createSettingsHost({ accounts: cloud })
	const requests: string[] = []
	vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
		if (new URL(url).hostname === 'localhost') return liveFetch(url, options)
		expect(new Headers(options.headers).get('authorization')).toBe('Bearer platform-token')
		expect(new URL(url).pathname).toMatch(/^\/api\/settings\//)
		requests.push(new URL(url).pathname)
		return serveSettings(new Request(url, options), server)
	})
	let token: string | null = 'platform-token'
	const accounts = cloudAccounts(local, {
		origin: 'https://cloud.example',
		getToken: async () => token
	})
	return {
		local,
		cloud,
		accounts,
		requests,
		signOut: () => {
			token = null
		}
	}
}

test('Mac signs in through the shell service and selects cloud text independently of images', async () => {
	const { local, cloud, accounts, requests, signOut } = setup()
	await accounts.connect({
		providerId: 'icloud',
		credentials: { username: 'local', password: 'password' }
	})
	await cloud.connect({
		providerId: 'icloud',
		credentials: { username: 'cloud', password: 'password' }
	})
	expect((await accounts.listProviders({})).map((p) => p.id)).toEqual([
		'icloud',
		'chatgpt',
		'frieren'
	])
	const ref = { providerId: 'chatgpt', operationId: 'attempt-1' }
	await accounts.beginConnect(ref)
	await vi.waitFor(async () =>
		expect(await accounts.readConnect(ref)).toMatchObject({ status: 'connected' })
	)
	const connected = await accounts.listAccounts({})
	expect(connected.map((a) => a.accountId)).toEqual(['local', 'chatgpt:person', 'frieren'])
	expect(connected.find((a) => a.providerId === 'chatgpt')?.enabled).toEqual([])
	expect(JSON.stringify(connected)).not.toContain('private-token')

	await accounts.setEnabled({ accountId: 'chatgpt:person', capability: 'ai', enabled: true })
	expect(await cloud.listAccounts({})).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ accountId: 'frieren', enabled: ['image'] }),
			expect.objectContaining({ accountId: 'chatgpt:person', enabled: ['ai'] })
		])
	)
	await accounts.cancelConnect(ref)
	await accounts.disconnect({ accountId: 'chatgpt:person' })
	expect(requests).toContain('/api/settings/cancelAccountConnection')
	expect((await cloud.listAccounts({})).find((a) => a.accountId === 'frieren')?.enabled).toEqual([
		'ai',
		'image'
	])

	await accounts.disconnect({ accountId: 'local' })
	expect(await local.listAccounts({})).toEqual([])
	await accounts.connect({
		providerId: 'icloud',
		credentials: { username: 'local', password: 'password' }
	})
	signOut()
	const count = requests.length
	expect((await accounts.listProviders({})).map((p) => p.id)).toEqual(['icloud'])
	expect((await accounts.listAccounts({})).map((a) => a.accountId)).toEqual(['local'])
	expect(requests).toHaveLength(count)
})

test('legacy local ChatGPT credentials survive until cloud sign-in succeeds', async () => {
	const { cloud } = setup()
	const fs = volume(memStore())
	await hostAccounts([chatgpt], fs).admin.connect({ providerId: 'chatgpt' })
	const local = hostAccounts([], fs).admin
	const accounts = cloudAccounts(local, {
		origin: 'https://cloud.example',
		getToken: async () => 'platform-token'
	})
	expect((await accounts.listAccounts({})).map((a) => a.providerId)).toEqual(['frieren'])
	expect(await local.listAccounts({})).toHaveLength(1)
	await cloud.connect({ providerId: 'chatgpt' })
	expect((await accounts.listAccounts({})).map((a) => a.providerId)).toEqual(['chatgpt', 'frieren'])
	expect(await local.listAccounts({})).toEqual([])
})

test('Mac relays a browser callback to the cloud and closes its listener', async () => {
	const authorization = new URL('https://auth.openai.com/oauth/authorize')
	authorization.search = new URLSearchParams({
		redirect_uri: 'http://localhost:1455/auth/callback',
		state: 'browser-state'
	}).toString()
	const { accounts, local, requests } = setup({
		...chatgpt,
		auth: {
			ui: { kind: 'interactive' },
			acquire: async ({ authorize }) => {
				expect(authorize).toBeTypeOf('function')
				const callback = await authorize!(authorization.href, (callback) => {
					if (callback.searchParams.get('state') !== 'browser-state')
						throw new Error('Invalid state')
				})
				expect(callback.searchParams.get('code')).toBe('one-time-code')
				return { accountId: 'chatgpt:person', creds: { access: 'cloud-only-secret' } }
			}
		}
	})
	const ref = { providerId: 'chatgpt', operationId: 'browser' }
	try {
		await accounts.beginConnect(ref)
		await accounts.beginConnect(ref)
		expect(requests.filter((path) => path.endsWith('/beginAccountConnection'))).toHaveLength(1)
		expect(await accounts.readConnect(ref)).toMatchObject({
			status: 'pending',
			prompt: { verificationUrl: authorization.href }
		})
		const wrong = await liveFetch(
			'http://localhost:1455/auth/callback?state=wrong&code=one-time-code'
		)
		expect(wrong.status).toBe(400)
		const response = await liveFetch(
			'http://localhost:1455/auth/callback?state=browser-state&code=one-time-code'
		)
		expect(response.status).toBe(200)
		expect(await response.text()).toContain('ChatGPT is connected')
		expect(await accounts.readConnect(ref)).toMatchObject({ status: 'connected' })
		expect(await local.listAccounts({})).toEqual([])
		expect(requests).toContain('/api/settings/completeAccountConnection')
		await expect(liveFetch('http://localhost:1455/')).rejects.toThrow()
	} finally {
		await accounts.cancelConnect(ref)
	}
})

test('Mac falls back to device sign-in when the callback port is busy', async () => {
	const blocker = createServer()
	await new Promise<void>((resolve) => blocker.listen(1455, '127.0.0.1', resolve))
	const acquire = vi.fn<typeof chatgpt.auth.acquire>(async ({ authorize }) => {
		expect(authorize).toBeUndefined()
		return { accountId: 'chatgpt:person', creds: {} }
	})
	try {
		const { accounts } = setup({ ...chatgpt, auth: { ui: { kind: 'interactive' }, acquire } })
		const ref = { providerId: 'chatgpt', operationId: 'fallback' }
		await accounts.beginConnect(ref)
		await vi.waitFor(async () =>
			expect(await accounts.readConnect(ref)).toMatchObject({ status: 'connected' })
		)
		expect(acquire).toHaveBeenCalledTimes(1)
	} finally {
		await new Promise<void>((resolve) => blocker.close(() => resolve()))
	}
})

test('Mac releases the callback port on cancellation and supports explicit device sign-in', async () => {
	const { accounts } = setup({
		...chatgpt,
		auth: {
			ui: { kind: 'interactive' },
			acquire: async ({ authorize }) => {
				if (authorize)
					await authorize(
						'https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=cancel-state',
						() => {}
					)
				return { accountId: 'chatgpt:person', creds: {} }
			}
		}
	})
	const ref = { providerId: 'chatgpt', operationId: 'cancel' }
	await accounts.beginConnect(ref)
	await accounts.cancelConnect(ref)
	await expect(liveFetch('http://localhost:1455/')).rejects.toThrow()
	const retry = { ...ref, operationId: 'retry' }
	await accounts.beginConnect({ ...retry, method: 'device_code' })
	await vi.waitFor(async () =>
		expect(await accounts.readConnect(retry)).toMatchObject({ status: 'connected' })
	)
})

test('closing Settings while the callback listener starts settles the pending request', async () => {
	const { accounts } = setup()
	const ref = { providerId: 'chatgpt', operationId: 'close-during-start' }
	const starting = accounts.beginConnect(ref)
	const closing = accounts.cancelConnect(ref)
	await Promise.allSettled([starting, closing])
	await expect(liveFetch('http://localhost:1455/')).rejects.toThrow()
})
