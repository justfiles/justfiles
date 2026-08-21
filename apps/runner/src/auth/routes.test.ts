import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, expect, test, vi } from 'vitest'
import worker from '../index'
import type { ReleaseManifest } from '../protocol'
import { toBase64Url } from './secret'
import { testDatabase } from './test-db'

afterEach(() => vi.unstubAllGlobals())

test('connects one app through consent and enforces each route binding', async () => {
	const { binding, sqlite } = testDatabase()
	const manifests = {
		'alice.notes': manifest('alice.notes', 'Notes'),
		'bob.tasks': manifest('bob.tasks', 'Tasks'),
		'justfiles.files': {
			...manifest('justfiles.files', 'Files'),
			capabilities: { volume: { id: 'volume', scopes: ['system'] } }
		}
	}
	const env = testEnv(binding, manifests)
	const pair = await generateKeyPair('RS256')
	const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'key-1', alg: 'RS256', use: 'sig' }
	let nonce = ''
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input)
			if (url.endsWith('/.well-known/oauth-authorization-server'))
				return Response.json({
					issuer: env.CLERK_ISSUER,
					authorization_endpoint: `${env.CLERK_ISSUER}/oauth/authorize`,
					token_endpoint: `${env.CLERK_ISSUER}/oauth/token`,
					jwks_uri: `${env.CLERK_ISSUER}/.well-known/jwks.json`,
					scopes_supported: ['openid', 'offline_access'],
					code_challenge_methods_supported: ['S256'],
					token_endpoint_auth_methods_supported: ['client_secret_basic']
				})
			if (url.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [jwk] })
			if (url.endsWith('/oauth/token'))
				return Response.json({
					access_token: 'access-token-must-stay-server-side',
					refresh_token: 'refresh-token-must-stay-server-side',
					id_token: await idToken(pair.privateKey, env, nonce),
					expires_in: 3_600,
					scope: 'openid offline_access',
					token_type: 'bearer'
				})
			throw new Error(`unexpected fetch: ${url}`)
		})
	)

	expect(await request('https://runner.workers.dev/connect?app=alice.notes', env)).toMatchObject({
		status: 404
	})
	const connect = await request(
		'https://example.com/connect?app=alice.notes&return=https://attacker.example',
		env
	)
	expect(connect.status).toBe(302)
	const authorization = new URL(connect.headers.get('location') ?? '')
	nonce = authorization.searchParams.get('nonce') ?? ''
	const state = authorization.searchParams.get('state') ?? ''
	expect(authorization.searchParams.get('redirect_uri')).toBe('https://example.com/auth/callback')
	expect(authorization.searchParams.get('scope')).toBe('openid offline_access')
	expect(authorization.href).not.toContain('attacker.example')
	const flowCookie = cookieValue(connect, '__Host-runner-flow')
	expectHostCookie(connect, '__Host-runner-flow')

	const callback = await request(
		`https://example.com/auth/callback?code=code_1&state=${encodeURIComponent(state)}`,
		env,
		{ headers: { cookie: `__Host-runner-flow=${flowCookie}` } }
	)
	expect(callback.status).toBe(303)
	expect(callback.headers.get('location')).toBe('/consent?app=alice.notes')
	expect(callback.headers.get('cache-control')).toBe('no-store')
	const rootCookie = cookieValue(callback, '__Host-runner-root')
	expectHostCookie(callback, '__Host-runner-root')
	const stored = sqlite.prepare('SELECT access_token, refresh_token FROM accounts').get() as {
		access_token: string
		refresh_token: string
	}
	expect(stored.access_token).toMatch(/^v1\./)
	expect(stored.refresh_token).toMatch(/^v1\./)
	expect(JSON.stringify(stored)).not.toContain('must-stay-server-side')
	expect(sqlite.prepare('SELECT COUNT(*) AS count FROM oauth_flows').get()).toEqual({ count: 0 })

	const replay = await request(
		`https://example.com/auth/callback?code=code_1&state=${encodeURIComponent(state)}`,
		env,
		{ headers: { cookie: `__Host-runner-flow=${flowCookie}` } }
	)
	expect(replay.status).toBe(400)

	const consent = await request('https://example.com/consent?app=alice.notes', env, {
		headers: { cookie: `__Host-runner-root=${rootCookie}` }
	})
	const consentPage = await consent.text()
	expect(consent.status).toBe(200)
	expect(consent.headers.get('content-security-policy')).toContain("form-action 'self'")
	expect(consentPage).toContain('Connect Notes to Frieren?')
	expect(consentPage).toContain('Use your Frieren AI budget.')
	expect(consentPage).toContain('part of your non-private Frieren volume')
	expect(consentPage).not.toContain('must-stay-server-side')
	const systemConsent = await request('https://example.com/consent?app=justfiles.files', env, {
		headers: { cookie: `__Host-runner-root=${rootCookie}` }
	})
	expect(await systemConsent.text()).toContain('your full non-private Frieren volume')
	const csrf = /name="csrf" value="([^"]+)"/.exec(consentPage)?.[1] ?? ''
	const consentBody = new URLSearchParams({ app: 'alice.notes', csrf })
	const deniedConsent = await request('https://example.com/consent', env, {
		method: 'POST',
		headers: {
			cookie: `__Host-runner-root=${rootCookie}`,
			origin: 'https://attacker.example',
			'content-type': 'application/x-www-form-urlencoded'
		},
		body: consentBody
	})
	expect(deniedConsent.status).toBe(403)

	const approved = await request('https://example.com/consent', env, {
		method: 'POST',
		headers: {
			cookie: `__Host-runner-root=${rootCookie}`,
			origin: 'https://example.com',
			'content-type': 'application/x-www-form-urlencoded'
		},
		body: consentBody
	})
	expect(approved.status).toBe(303)
	const appCallback = new URL(approved.headers.get('location') ?? '')
	expect(appCallback.origin + appCallback.pathname).toBe(
		'https://alice-notes.example.com/_runner/connect/callback'
	)
	const ticket = appCallback.searchParams.get('ticket') ?? ''
	expect(ticket).toHaveLength(43)
	expect(
		sqlite
			.prepare(
				`SELECT resources, ticket_origin FROM app_grants, sessions
				 WHERE sessions.kind = 'ticket'`
			)
			.get()
	).toEqual({
		resources: '["ai","volume:app"]',
		ticket_origin: 'https://alice-notes.example.com'
	})

	const wrongApp = await request(
		`https://bob-tasks.example.com/_runner/connect/callback?ticket=${ticket}`,
		env
	)
	expect(wrongApp.status).toBe(400)
	const wrongOrigin = await request(
		`http://alice-notes.localhost:8787/_runner/connect/callback?ticket=${ticket}`,
		env
	)
	expect(wrongOrigin.status).toBe(400)
	const connected = await request(appCallback.href, env)
	expect(connected.status).toBe(303)
	expect(connected.headers.get('location')).toBe('/')
	const appCookie = cookieValue(connected, '__Host-runner-app')
	expectHostCookie(connected, '__Host-runner-app')
	expect((await request(appCallback.href, env)).status).toBe(400)

	const appSession = sqlite
		.prepare("SELECT request_nonce FROM sessions WHERE kind = 'app'")
		.get() as { request_nonce: string }
	expect(
		(
			await request('https://alice-notes.example.com/_runner/account', env, {
				headers: { cookie: `__Host-runner-app=${appCookie}` }
			})
		).status
	).toBe(403)
	const status = await request('https://alice-notes.example.com/_runner/account', env, {
		headers: {
			cookie: `__Host-runner-app=${appCookie}`,
			'x-runner-request': appSession.request_nonce
		}
	})
	const statusBody = await status.json()
	expect(statusBody).toEqual({
		connected: true,
		resources: ['ai', 'volume:app']
	})
	expect(JSON.stringify(statusBody)).not.toContain('requestNonce')

	manifests['alice.notes'].capabilities = {
		...manifests['alice.notes'].capabilities,
		notify: { id: 'notify', scopes: [] }
	}
	expect(
		await (
			await request('https://alice-notes.example.com/_runner/account', env, {
				headers: {
					cookie: `__Host-runner-app=${appCookie}`,
					'x-runner-request': appSession.request_nonce
				}
			})
		).json()
	).toEqual({ connected: false })
	delete manifests['alice.notes'].capabilities?.notify

	const deniedDisconnect = await request(
		'https://alice-notes.example.com/_runner/disconnect',
		env,
		{
			method: 'POST',
			headers: {
				cookie: `__Host-runner-app=${appCookie}`,
				origin: 'https://alice-notes.example.com',
				'content-type': 'application/x-www-form-urlencoded',
				'x-runner-request': 'wrong'
			},
			body: ''
		}
	)
	expect(deniedDisconnect.status).toBe(403)
	const disconnected = await request('https://alice-notes.example.com/_runner/disconnect', env, {
		method: 'POST',
		headers: {
			cookie: `__Host-runner-app=${appCookie}`,
			origin: 'https://alice-notes.example.com',
			'content-type': 'application/x-www-form-urlencoded',
			'x-runner-request': appSession.request_nonce
		},
		body: ''
	})
	expect(disconnected.status).toBe(204)
	expect(sqlite.prepare("SELECT COUNT(*) AS count FROM sessions WHERE kind = 'app'").get()).toEqual(
		{ count: 0 }
	)
	expect(sqlite.prepare('SELECT revoked_at IS NOT NULL AS revoked FROM app_grants').get()).toEqual({
		revoked: 1
	})

	const runnerDisconnect = await request('https://example.com/disconnect', env, {
		method: 'POST',
		headers: {
			cookie: `__Host-runner-root=${rootCookie}`,
			origin: 'https://example.com',
			'content-type': 'application/x-www-form-urlencoded'
		},
		body: new URLSearchParams({ csrf })
	})
	expect(runnerDisconnect.status).toBe(303)
	expect(sqlite.prepare('SELECT COUNT(*) AS count FROM accounts').get()).toEqual({ count: 0 })
})

const manifest = (id: string, name: string): ReleaseManifest => ({
	schema: 'justapps/manifest/v1',
	id,
	name,
	version: '1.0.0',
	app: 'app.js',
	gui: 'gui.js',
	capabilities: {
		volume: { id: 'volume', scopes: ['app'] },
		ai: { id: 'ai', scopes: [] }
	},
	hash: 'release-hash',
	files: []
})

const testEnv = (
	AUTH_DB: D1Database,
	manifests: Record<string, ReleaseManifest>
): CloudflareBindings =>
	({
		ROOT_DOMAIN: 'example.com',
		CLERK_ISSUER: 'https://clerk.example.com',
		CLERK_CLIENT_ID: 'client_1',
		CLERK_CLIENT_SECRET: 'client_secret_1',
		TOKEN_SEAL_KEY_V1: toBase64Url(new Uint8Array(32).fill(7)),
		GITHUB_TOKEN: 'unused',
		AUTH_DB,
		STORE: {
			get: async (key: string) => {
				const match = /^apps\/([^/]+)\/(?:record\.json|(1\.0\.0)\/manifest\.json)$/.exec(key)
				if (!match?.[1] || !manifests[match[1]]) return null
				const value = match[2]
					? manifests[match[1]]
					: { current: '1.0.0', releases: { '1.0.0': { state: 'ready' } } }
				return { json: async () => value }
			}
		} as unknown as R2Bucket
	}) as unknown as CloudflareBindings

const request = (url: string, env: CloudflareBindings, init?: RequestInit): Promise<Response> =>
	worker.fetch(new Request(url, init), env, {} as ExecutionContext)

async function idToken(key: CryptoKey, env: CloudflareBindings, nonce: string): Promise<string> {
	return new SignJWT({ nonce })
		.setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
		.setIssuer(env.CLERK_ISSUER)
		.setAudience(env.CLERK_CLIENT_ID)
		.setSubject('user_1')
		.setIssuedAt()
		.setExpirationTime('5m')
		.sign(key)
}

const setCookies = (response: Response): string[] => {
	const headers = response.headers as Headers & { getSetCookie?: () => string[] }
	return headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? '']
}

const cookieValue = (response: Response, name: string): string => {
	const match = new RegExp(`${name}=([^;,]+)`).exec(setCookies(response).join(','))
	return match?.[1] ?? ''
}

const expectHostCookie = (response: Response, name: string): void => {
	const value = setCookies(response).find((header) => header.startsWith(`${name}=`)) ?? ''
	expect(value).toContain('Path=/')
	expect(value).toContain('HttpOnly')
	expect(value).toContain('Secure')
	expect(value).toContain('SameSite=Lax')
	expect(value).not.toContain('Domain=')
}
