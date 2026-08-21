import { afterEach, expect, test, vi } from 'vitest'
import { accessToken } from './access'
import { putAccount, readAccount } from './account'
import { toBase64Url } from './secret'
import { testDatabase } from './test-db'
import { tokenCodec } from './token'

const NOW = 1_700_000_000_000
const config = {
	CLERK_ISSUER: 'https://clerk.example.com',
	CLERK_CLIENT_ID: 'client_1',
	CLERK_CLIENT_SECRET: 'secret_1'
}
const codec = tokenCodec(toBase64Url(new Uint8Array(32).fill(7)))

afterEach(() => vi.unstubAllGlobals())

test('refreshes an expired access token and saves both rotated tokens', async () => {
	const { database } = testDatabase()
	await putAccount(database, codec, {
		userId: 'user_1',
		accessToken: 'access-1',
		refreshToken: 'refresh-1',
		accessExpiresAt: NOW - 1,
		scopes: ['openid', 'offline_access']
	})
	const requests: Request[] = []

	expect(
		await accessToken(
			database,
			codec,
			config,
			'user_1',
			async (input, init) => {
				const request = new Request(input, init)
				requests.push(request)
				if (request.url.endsWith('/.well-known/oauth-authorization-server'))
					return Response.json(metadata())
				return Response.json({
					access_token: 'access-2',
					refresh_token: 'refresh-2',
					expires_in: 3_600,
					token_type: 'bearer'
				})
			},
			NOW
		)
	).toBe('access-2')
	expect(await requests[1]?.text()).toBe(
		new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: 'refresh-1'
		}).toString()
	)
	expect(await readAccount(database, codec, 'user_1')).toMatchObject({
		accessToken: 'access-2',
		refreshToken: 'refresh-2',
		accessExpiresAt: NOW + 3_600_000
	})
})

test('drops the account after Clerk rejects the refresh grant', async () => {
	const { database } = testDatabase()
	await putAccount(database, codec, {
		userId: 'user_1',
		accessToken: 'access-1',
		refreshToken: 'refresh-1',
		accessExpiresAt: NOW - 1,
		scopes: ['openid', 'offline_access']
	})

	await expect(
		accessToken(
			database,
			codec,
			config,
			'user_1',
			async (input) =>
				String(input).endsWith('/.well-known/oauth-authorization-server')
					? Response.json(metadata())
					: Response.json({ error: 'invalid_grant' }, { status: 400 }),
			NOW
		)
	).rejects.toThrow()
	expect(await readAccount(database, codec, 'user_1')).toBeNull()
})

test('an old failed refresh does not delete a new connection', async () => {
	const { database } = testDatabase()
	await putAccount(database, codec, {
		userId: 'user_1',
		accessToken: 'access-1',
		refreshToken: 'refresh-1',
		accessExpiresAt: NOW - 1,
		scopes: ['openid', 'offline_access']
	})

	await expect(
		accessToken(
			database,
			codec,
			config,
			'user_1',
			async (input) => {
				if (String(input).endsWith('/.well-known/oauth-authorization-server'))
					return Response.json(metadata())
				await putAccount(database, codec, {
					userId: 'user_1',
					accessToken: 'access-new',
					refreshToken: 'refresh-new',
					accessExpiresAt: NOW + 3_600_000,
					scopes: ['openid', 'offline_access']
				})
				return Response.json({ error: 'invalid_grant' }, { status: 400 })
			},
			NOW
		)
	).rejects.toThrow()
	expect(await readAccount(database, codec, 'user_1')).toMatchObject({
		accessToken: 'access-new',
		refreshToken: 'refresh-new'
	})
})

test('waits for another caller to refresh an expired token', async () => {
	const { database } = testDatabase()
	await putAccount(database, codec, {
		userId: 'user_1',
		accessToken: 'access-1',
		refreshToken: 'refresh-1',
		accessExpiresAt: NOW - 1,
		scopes: ['openid', 'offline_access']
	})
	let startRefresh = () => {}
	const refreshing = new Promise<void>((resolve) => {
		startRefresh = resolve
	})
	let finishRefresh = () => {}
	const held = new Promise<void>((resolve) => {
		finishRefresh = resolve
	})
	const fetcher = vi.fn(async (input: RequestInfo | URL) => {
		if (String(input).endsWith('/.well-known/oauth-authorization-server'))
			return Response.json(metadata())
		startRefresh()
		await held
		return Response.json({
			access_token: 'access-2',
			refresh_token: 'refresh-2',
			expires_in: 3_600,
			token_type: 'bearer'
		})
	})
	const first = accessToken(database, codec, config, 'user_1', fetcher, NOW)
	await refreshing
	const wait = vi.fn(async () => {
		finishRefresh()
		await first
	})
	vi.stubGlobal('scheduler', { wait })

	await expect(
		Promise.all([first, accessToken(database, codec, config, 'user_1', fetcher, NOW)])
	).resolves.toEqual(['access-2', 'access-2'])
	expect(fetcher).toHaveBeenCalledTimes(2)
	expect(wait).toHaveBeenCalledOnce()
})

const metadata = () => ({
	issuer: config.CLERK_ISSUER,
	authorization_endpoint: `${config.CLERK_ISSUER}/oauth/authorize`,
	token_endpoint: `${config.CLERK_ISSUER}/oauth/token`,
	jwks_uri: `${config.CLERK_ISSUER}/.well-known/jwks.json`,
	scopes_supported: ['openid', 'offline_access'],
	grant_types_supported: ['authorization_code', 'refresh_token'],
	code_challenge_methods_supported: ['S256'],
	token_endpoint_auth_methods_supported: ['client_secret_basic']
})
