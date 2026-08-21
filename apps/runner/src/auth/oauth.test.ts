import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { expect, test } from 'vitest'
import { authorizationUrl, discover, exchangeCode } from './oauth'

const NOW = 1_700_000_000_000
const config = {
	CLERK_ISSUER: 'https://clerk.example.com',
	CLERK_CLIENT_ID: 'client_1',
	CLERK_CLIENT_SECRET: 'secret_1'
}

const metadata = {
	issuer: config.CLERK_ISSUER,
	authorizationEndpoint: `${config.CLERK_ISSUER}/oauth/authorize`,
	tokenEndpoint: `${config.CLERK_ISSUER}/oauth/token`,
	jwksUri: `${config.CLERK_ISSUER}/.well-known/jwks.json`
} satisfies Parameters<typeof authorizationUrl>[0]

test('discovers Clerk endpoints and builds the fixed authorization request', async () => {
	const found = await discover(config, async () =>
		Response.json({
			issuer: config.CLERK_ISSUER,
			authorization_endpoint: metadata.authorizationEndpoint,
			token_endpoint: metadata.tokenEndpoint,
			jwks_uri: metadata.jwksUri,
			scopes_supported: ['openid', 'offline_access', 'profile'],
			grant_types_supported: ['authorization_code', 'refresh_token'],
			code_challenge_methods_supported: ['S256'],
			token_endpoint_auth_methods_supported: ['client_secret_basic']
		})
	)
	const url = new URL(
		authorizationUrl(found, config, {
			callback: 'https://runner.example.com/auth/callback',
			state: 'state',
			nonce: 'nonce',
			challenge: 'challenge'
		})
	)

	expect(url.origin + url.pathname).toBe(metadata.authorizationEndpoint)
	expect(Object.fromEntries(url.searchParams)).toEqual({
		response_type: 'code',
		client_id: 'client_1',
		redirect_uri: 'https://runner.example.com/auth/callback',
		scope: 'openid offline_access',
		state: 'state',
		nonce: 'nonce',
		code_challenge: 'challenge',
		code_challenge_method: 'S256'
	})
})

test('rejects metadata for another issuer or an insecure endpoint', async () => {
	for (const changed of [
		{ issuer: 'https://other.example.com' },
		{ token_endpoint: 'http://clerk.example.com/oauth/token' }
	]) {
		await expect(
			discover(config, async () =>
				Response.json({
					issuer: config.CLERK_ISSUER,
					authorization_endpoint: metadata.authorizationEndpoint,
					token_endpoint: metadata.tokenEndpoint,
					jwks_uri: metadata.jwksUri,
					scopes_supported: ['openid', 'offline_access'],
					grant_types_supported: ['authorization_code', 'refresh_token'],
					code_challenge_methods_supported: ['S256'],
					token_endpoint_auth_methods_supported: ['client_secret_basic'],
					...changed
				})
			)
		).rejects.toThrow()
	}
})

test('exchanges the code with PKCE and verifies the ID token', async () => {
	const pair = await generateKeyPair('RS256')
	const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'key-1', alg: 'RS256', use: 'sig' }
	const idToken = await signedIdToken(pair.privateKey, {})
	let tokenRequest: RequestInit | undefined
	const tokens = await exchangeCode(
		metadata,
		config,
		{
			code: 'code_1',
			callback: 'https://runner.example.com/auth/callback',
			verifier: 'verifier_1',
			nonce: 'nonce_1'
		},
		async (input, init) => {
			if (String(input) === metadata.jwksUri) return Response.json({ keys: [jwk] })
			tokenRequest = init
			return tokenResponse(idToken)
		},
		NOW
	)

	expect(tokens).toEqual({
		userId: 'user_1',
		accessToken: 'access-token',
		refreshToken: 'refresh-token',
		accessExpiresAt: NOW + 3_600_000,
		scopes: ['offline_access', 'openid']
	})
	expect(new Headers(tokenRequest?.headers).get('authorization')).toBe(
		`Basic ${btoa('client_1:secret_1')}`
	)
	expect(new URLSearchParams(String(tokenRequest?.body))).toEqual(
		new URLSearchParams({
			grant_type: 'authorization_code',
			code: 'code_1',
			redirect_uri: 'https://runner.example.com/auth/callback',
			code_verifier: 'verifier_1'
		})
	)
})

test('checks ID token issuer, audience, nonce, signature, and expiry', async () => {
	const trusted = await generateKeyPair('RS256')
	const other = await generateKeyPair('RS256')
	const jwk = { ...(await exportJWK(trusted.publicKey)), kid: 'key-1', alg: 'RS256', use: 'sig' }
	const cases = [
		await signedIdToken(trusted.privateKey, { issuer: 'https://other.example.com' }),
		await signedIdToken(trusted.privateKey, { audience: 'other-client' }),
		await signedIdToken(trusted.privateKey, { nonce: 'wrong-nonce' }),
		await signedIdToken(trusted.privateKey, { expiresAt: NOW / 1_000 - 10 }),
		await signedIdToken(trusted.privateKey, { expiresAt: null }),
		await signedIdToken(other.privateKey, {})
	]

	for (const idToken of cases) {
		await expect(
			exchangeCode(
				metadata,
				config,
				{
					code: 'code_1',
					callback: 'https://runner.example.com/auth/callback',
					verifier: 'verifier_1',
					nonce: 'nonce_1'
				},
				async (input) =>
					String(input) === metadata.jwksUri
						? Response.json({ keys: [jwk] })
						: tokenResponse(idToken),
				NOW
			)
		).rejects.toThrow()
	}
})

async function signedIdToken(
	key: CryptoKey,
	overrides: {
		issuer?: string
		audience?: string
		nonce?: string
		expiresAt?: number | null
	}
): Promise<string> {
	const now = NOW / 1_000
	const token = new SignJWT({ nonce: overrides.nonce ?? 'nonce_1' })
		.setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
		.setIssuer(overrides.issuer ?? config.CLERK_ISSUER)
		.setAudience(overrides.audience ?? config.CLERK_CLIENT_ID)
		.setSubject('user_1')
		.setIssuedAt(now)
	if (overrides.expiresAt !== null) token.setExpirationTime(overrides.expiresAt ?? now + 60)
	return token.sign(key)
}

const tokenResponse = (idToken: string): Response =>
	Response.json({
		access_token: 'access-token',
		refresh_token: 'refresh-token',
		id_token: idToken,
		expires_in: 3_600,
		scope: 'openid offline_access',
		token_type: 'bearer'
	})
