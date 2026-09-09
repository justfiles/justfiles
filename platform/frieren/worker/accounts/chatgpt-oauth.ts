import type { OAuthCredential } from '@earendil-works/pi-ai'

const clientId = 'app_EMoamEEZ73f0CkXaXp7hrann'
const redirectUri = 'http://localhost:1455/auth/callback'

// OpenAI's installed client uses a loopback callback. The Mac relays the code;
// PKCE and the token exchange stay here with the encrypted cloud account.
export async function browserLogin(
	authorize: (url: string, validate: (callback: URL) => void) => Promise<URL>,
	signal?: AbortSignal
): Promise<OAuthCredential> {
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
	const challenge = base64url(
		new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
	)
	const state = base64url(crypto.getRandomValues(new Uint8Array(32)))
	const url = new URL('https://auth.openai.com/oauth/authorize')
	url.search = new URLSearchParams({
		response_type: 'code',
		client_id: clientId,
		redirect_uri: redirectUri,
		scope: 'openid profile email offline_access',
		code_challenge: challenge,
		code_challenge_method: 'S256',
		state,
		id_token_add_organizations: 'true',
		codex_cli_simplified_flow: 'true',
		originator: 'pi'
	}).toString()
	const callback = await authorize(url.href, (callback) => {
		if (
			callback.origin + callback.pathname !== redirectUri ||
			callback.searchParams.get('state') !== state
		)
			throw new Error('Invalid sign-in callback')
	})
	signal?.throwIfAborted()
	const code = callback.searchParams.get('code')
	if (!code || callback.searchParams.has('error')) throw new Error('Sign-in was not approved')
	const credential = await tokens(
		{
			grant_type: 'authorization_code',
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri
		},
		signal
	)
	const payload = JSON.parse(
		atob((credential.access.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'))
	)
	const accountId = payload['https://api.openai.com/auth']?.chatgpt_account_id
	if (typeof accountId !== 'string' || !accountId) throw new Error('Missing account identity')
	return { type: 'oauth', ...credential, accountId }
}

export async function refresh(
	credential: OAuthCredential,
	signal?: AbortSignal
): Promise<OAuthCredential> {
	return {
		...credential,
		...(await tokens({ grant_type: 'refresh_token', refresh_token: credential.refresh }, signal))
	}
}

async function tokens(grant: Record<string, string>, signal?: AbortSignal) {
	const timeout = AbortSignal.timeout(30_000)
	const response = await fetch('https://auth.openai.com/oauth/token', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ ...grant, client_id: clientId }),
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout
	})
	if (!response.ok)
		throw new Error(
			response.status === 400 || response.status === 401
				? 'ChatGPT needs a fresh sign-in. Reconnect it in Settings.'
				: 'ChatGPT sign-in service is unavailable. Please retry shortly.'
		)
	const token = (await response.json()) as {
		access_token?: string
		refresh_token?: string
		expires_in?: number
	}
	if (
		typeof token.access_token !== 'string' ||
		!token.access_token ||
		typeof token.refresh_token !== 'string' ||
		!token.refresh_token ||
		typeof token.expires_in !== 'number' ||
		!Number.isFinite(token.expires_in) ||
		token.expires_in <= 0
	)
		throw new Error('ChatGPT returned an invalid credential. Reconnect it in Settings.')
	return {
		access: token.access_token,
		refresh: token.refresh_token,
		expires: Date.now() + token.expires_in * 1000
	}
}

function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '')
}
