import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose'

const SCOPES = ['openid', 'offline_access'] as const
const TIMEOUT_MS = 5_000

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

interface OAuthConfig {
	CLERK_ISSUER: string
	CLERK_CLIENT_ID: string
	CLERK_CLIENT_SECRET: string
}

interface OAuthMetadata {
	issuer: string
	authorizationEndpoint: string
	tokenEndpoint: string
	jwksUri: string
}

interface OAuthTokens {
	userId: string
	accessToken: string
	refreshToken: string
	accessExpiresAt: number
	scopes: string[]
}

export class OAuthGrantExpired extends Error {
	constructor() {
		super('OAuth refresh grant expired')
		this.name = 'OAuthGrantExpired'
	}
}

export async function discover(
	config: OAuthConfig,
	fetcher: Fetcher = fetch
): Promise<OAuthMetadata> {
	const issuer = cleanIssuer(config.CLERK_ISSUER)
	const response = await fetcher(`${issuer}/.well-known/oauth-authorization-server`, {
		headers: { accept: 'application/json' },
		redirect: 'manual',
		signal: AbortSignal.timeout(TIMEOUT_MS)
	})
	if (!response.ok) throw new Error('OAuth metadata request failed')
	const value: unknown = await response.json()
	if (!isRecord(value) || cleanIssuer(value.issuer) !== issuer)
		throw new Error('OAuth metadata has the wrong issuer')
	if (!hasStrings(value.scopes_supported, SCOPES))
		throw new Error('OAuth server does not support the required scopes')
	if (!hasStrings(value.code_challenge_methods_supported, ['S256']))
		throw new Error('OAuth server does not support S256 PKCE')
	if (!hasStrings(value.token_endpoint_auth_methods_supported, ['client_secret_basic']))
		throw new Error('OAuth server does not support confidential clients')
	if (!hasStrings(value.grant_types_supported, ['authorization_code', 'refresh_token']))
		throw new Error('OAuth server does not support the required grants')

	return {
		issuer,
		authorizationEndpoint: endpoint(value.authorization_endpoint),
		tokenEndpoint: endpoint(value.token_endpoint),
		jwksUri: endpoint(value.jwks_uri)
	}
}

export async function refreshAccessToken(
	metadata: OAuthMetadata,
	config: OAuthConfig,
	refreshToken: string,
	fetcher: Fetcher = fetch,
	now = Date.now()
): Promise<{ accessToken: string; refreshToken: string; accessExpiresAt: number }> {
	const response = await fetcher(metadata.tokenEndpoint, {
		method: 'POST',
		headers: {
			accept: 'application/json',
			authorization: `Basic ${basicCredentials(
				config.CLERK_CLIENT_ID,
				config.CLERK_CLIENT_SECRET
			)}`,
			'content-type': 'application/x-www-form-urlencoded'
		},
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken
		}),
		redirect: 'manual',
		signal: AbortSignal.timeout(TIMEOUT_MS)
	})
	const value: unknown = await response.json().catch(() => null)
	if (!response.ok) {
		if (response.status === 400 && isRecord(value) && value.error === 'invalid_grant')
			throw new OAuthGrantExpired()
		throw new Error('OAuth token refresh failed')
	}
	if (!isRefreshResponse(value)) throw new Error('OAuth refresh response is invalid')
	return {
		accessToken: value.access_token,
		refreshToken: value.refresh_token,
		accessExpiresAt: now + value.expires_in * 1_000
	}
}

export function authorizationUrl(
	metadata: OAuthMetadata,
	config: OAuthConfig,
	input: {
		callback: string
		state: string
		nonce: string
		challenge: string
	}
): string {
	const url = new URL(metadata.authorizationEndpoint)
	url.search = new URLSearchParams({
		response_type: 'code',
		client_id: config.CLERK_CLIENT_ID,
		redirect_uri: input.callback,
		scope: SCOPES.join(' '),
		state: input.state,
		nonce: input.nonce,
		code_challenge: input.challenge,
		code_challenge_method: 'S256'
	}).toString()
	return url.href
}

export async function exchangeCode(
	metadata: OAuthMetadata,
	config: OAuthConfig,
	input: { code: string; callback: string; verifier: string; nonce: string },
	fetcher: Fetcher = fetch,
	now = Date.now()
): Promise<OAuthTokens> {
	const response = await fetcher(metadata.tokenEndpoint, {
		method: 'POST',
		headers: {
			accept: 'application/json',
			authorization: `Basic ${basicCredentials(
				config.CLERK_CLIENT_ID,
				config.CLERK_CLIENT_SECRET
			)}`,
			'content-type': 'application/x-www-form-urlencoded'
		},
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code: input.code,
			redirect_uri: input.callback,
			code_verifier: input.verifier
		}),
		redirect: 'manual',
		signal: AbortSignal.timeout(TIMEOUT_MS)
	})
	if (!response.ok) throw new Error('OAuth code exchange failed')

	const value: unknown = await response.json()
	if (!isTokenResponse(value)) throw new Error('OAuth token response is invalid')
	const scopes = [...new Set(value.scope.split(/\s+/).filter(Boolean))].sort()
	if (!SCOPES.every((scope) => scopes.includes(scope)))
		throw new Error('OAuth token response is missing a required scope')

	const keys = createRemoteJWKSet(new URL(metadata.jwksUri), {
		[customFetch]: (url, options) => fetcher(url, options)
	})
	const { payload } = await jwtVerify(value.id_token, keys, {
		issuer: metadata.issuer,
		audience: config.CLERK_CLIENT_ID,
		algorithms: ['RS256'],
		clockTolerance: 5,
		currentDate: new Date(now),
		requiredClaims: ['exp', 'sub', 'nonce']
	})
	if (payload.nonce !== input.nonce || typeof payload.sub !== 'string' || !payload.sub)
		throw new Error('OAuth ID token is invalid')

	return {
		userId: payload.sub,
		accessToken: value.access_token,
		refreshToken: value.refresh_token,
		accessExpiresAt: now + value.expires_in * 1_000,
		scopes
	}
}

const cleanIssuer = (value: unknown): string => {
	if (typeof value !== 'string') throw new Error('OAuth issuer is invalid')
	const url = new URL(value)
	if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
		throw new Error('OAuth issuer is invalid')
	return url.href.replace(/\/$/, '')
}

const endpoint = (value: unknown): string => {
	if (typeof value !== 'string') throw new Error('OAuth metadata endpoint is invalid')
	const url = new URL(value)
	if (url.protocol !== 'https:' || url.username || url.password || url.hash)
		throw new Error('OAuth metadata endpoint is invalid')
	return url.href
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null

const hasStrings = (value: unknown, required: readonly string[]): boolean =>
	Array.isArray(value) && required.every((item) => value.includes(item))

const isTokenResponse = (
	value: unknown
): value is {
	access_token: string
	refresh_token: string
	id_token: string
	expires_in: number
	scope: string
	token_type: string
} =>
	isRefreshResponse(value) &&
	typeof value.id_token === 'string' &&
	value.id_token.length > 0 &&
	typeof value.scope === 'string'

const isRefreshResponse = (
	value: unknown
): value is Record<string, unknown> & {
	access_token: string
	refresh_token: string
	expires_in: number
	token_type: string
} =>
	isRecord(value) &&
	typeof value.access_token === 'string' &&
	value.access_token.length > 0 &&
	typeof value.refresh_token === 'string' &&
	value.refresh_token.length > 0 &&
	typeof value.expires_in === 'number' &&
	Number.isSafeInteger(value.expires_in) &&
	value.expires_in > 0 &&
	typeof value.token_type === 'string' &&
	value.token_type.toLowerCase() === 'bearer'

const basicCredentials = (clientId: string, secret: string): string =>
	btoa(`${formValue(clientId)}:${formValue(secret)}`)

// OAuth Basic auth requires form encoding before Base64 encoding.
const formValue = (value: string): string =>
	new URLSearchParams({ value }).toString().slice('value='.length)
