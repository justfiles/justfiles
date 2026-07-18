// OpenAI Codex (ChatGPT) OAuth — browser + loopback PKCE flow, run in the daemon.
//
// pi-ai used to expose `loginOpenAICodex` / `refreshOpenAICodexToken` from
// `@mariozechner/pi-ai/oauth`. In `@earendil-works/pi-ai` (0.80.x) the OAuth flows
// moved behind the internal `OAuthAuth`/`Models` machinery and are no longer part of
// the public export surface, so we own the ~120 lines here. It's the Codex CLI flow
// (PKCE, the 127.0.0.1:1455 loopback catcher, token exchange, refresh) — the same
// thing chatgpt.ts already framed as "runs here in the daemon". Node-only (crypto/http).

import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

const CALLBACK_HOST = process.env.PI_OAUTH_CALLBACK_HOST || '127.0.0.1'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const REDIRECT_URI = 'http://localhost:1455/auth/callback'
const SCOPE = 'openid profile email offline_access'
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

// The token shape chatgpt.ts persists as its account creds.
export interface CodexToken {
	access: string
	refresh: string
	expires: number
	accountId: string
}

export interface CodexLoginOptions {
	// Called with the consent URL to open (the daemon shells out to `open`).
	onAuth: (info: { url: string; instructions?: string }) => void
	// Fallback when the loopback can't catch the code (e.g. port 1455 in use).
	onPrompt: (prompt: { message: string }) => Promise<string>
}

export async function loginOpenAICodex(options: CodexLoginOptions): Promise<CodexToken> {
	const { verifier, state, url } = await createAuthorizationFlow()
	const server = await startLocalOAuthServer(state)
	options.onAuth({ url, instructions: 'A browser window should open. Complete login to finish.' })

	try {
		let code = (await server.waitForCode())?.code
		if (!code) {
			const parsed = parseAuthorizationInput(
				await options.onPrompt({ message: 'Paste the authorization code (or full redirect URL):' })
			)
			if (parsed.state && parsed.state !== state) throw new Error('State mismatch')
			code = parsed.code
		}
		if (!code) throw new Error('Missing authorization code')

		const token = await exchangeToken({
			grant_type: 'authorization_code',
			client_id: CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: REDIRECT_URI
		})
		return withAccountId(token)
	} finally {
		server.close()
	}
}

export async function refreshOpenAICodexToken(refreshToken: string): Promise<CodexToken> {
	const token = await exchangeToken({
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
		client_id: CLIENT_ID
	})
	return withAccountId(token)
}

async function exchangeToken(
	params: Record<string, string>
): Promise<Omit<CodexToken, 'accountId'>> {
	const response = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(params)
	})
	if (!response.ok) {
		const text = await response.text().catch(() => '')
		throw new Error(`OpenAI Codex token request failed (${response.status}): ${text}`)
	}
	const json = (await response.json()) as {
		access_token?: string
		refresh_token?: string
		expires_in?: number
	}
	if (!json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
		throw new Error(`OpenAI Codex token response missing fields: ${JSON.stringify(json)}`)
	}
	return {
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000
	}
}

function withAccountId(token: Omit<CodexToken, 'accountId'>): CodexToken {
	const accountId = getAccountId(token.access)
	if (!accountId) throw new Error('Failed to extract accountId from token')
	return { ...token, accountId }
}

async function createAuthorizationFlow(): Promise<{
	verifier: string
	state: string
	url: string
}> {
	const { verifier, challenge } = await generatePKCE()
	const state = randomBytes(16).toString('hex')
	const url = new URL(AUTHORIZE_URL)
	url.searchParams.set('response_type', 'code')
	url.searchParams.set('client_id', CLIENT_ID)
	url.searchParams.set('redirect_uri', REDIRECT_URI)
	url.searchParams.set('scope', SCOPE)
	url.searchParams.set('code_challenge', challenge)
	url.searchParams.set('code_challenge_method', 'S256')
	url.searchParams.set('state', state)
	url.searchParams.set('id_token_add_organizations', 'true')
	url.searchParams.set('codex_cli_simplified_flow', 'true')
	url.searchParams.set('originator', 'pi')
	return { verifier, state, url: url.toString() }
}

interface OAuthServer {
	close: () => void
	waitForCode: () => Promise<{ code: string } | null>
}

function startLocalOAuthServer(state: string): Promise<OAuthServer> {
	let settle: ((value: { code: string } | null) => void) | undefined
	const codePromise = new Promise<{ code: string } | null>((resolve) => {
		let settled = false
		settle = (value) => {
			if (settled) return
			settled = true
			resolve(value)
		}
	})

	const server = createServer((req, res) => {
		const reply = (status: number, body: string) => {
			res.statusCode = status
			res.setHeader('Content-Type', 'text/html; charset=utf-8')
			res.end(body)
		}
		try {
			const url = new URL(req.url || '', 'http://localhost')
			if (url.pathname !== '/auth/callback') return reply(404, page('Callback route not found.'))
			if (url.searchParams.get('state') !== state) return reply(400, page('State mismatch.'))
			const code = url.searchParams.get('code')
			if (!code) return reply(400, page('Missing authorization code.'))
			reply(200, page('OpenAI authentication completed. You can close this window.'))
			settle?.({ code })
		} catch {
			reply(500, page('Internal error while processing OAuth callback.'))
		}
	})

	return new Promise((resolve) => {
		server
			.listen(1455, CALLBACK_HOST, () =>
				resolve({ close: () => server.close(), waitForCode: () => codePromise })
			)
			.on('error', (err: NodeJS.ErrnoException) => {
				console.error(`[openai-codex] Failed to bind ${CALLBACK_HOST}:1455 (${err.code})`)
				settle?.(null)
				resolve({
					close: () => {
						try {
							server.close()
						} catch {
							// already closed / never bound
						}
					},
					waitForCode: async () => null
				})
			})
	})
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim()
	if (!value) return {}
	try {
		const url = new URL(value)
		return {
			code: url.searchParams.get('code') ?? undefined,
			state: url.searchParams.get('state') ?? undefined
		}
	} catch {
		// not a URL — fall through to fragment / query-fragment forms
	}
	if (value.includes('#')) {
		const [code, state] = value.split('#', 2)
		return { code, state }
	}
	if (value.includes('code=')) {
		const params = new URLSearchParams(value)
		return {
			code: params.get('code') ?? undefined,
			state: params.get('state') ?? undefined
		}
	}
	return { code: value }
}

function getAccountId(accessToken: string): string | null {
	const parts = accessToken.split('.')
	if (parts.length !== 3) return null
	try {
		const payload = JSON.parse(atob(parts[1] ?? '')) as {
			[JWT_CLAIM_PATH]?: { chatgpt_account_id?: string }
		}
		const accountId = payload[JWT_CLAIM_PATH]?.chatgpt_account_id
		return typeof accountId === 'string' && accountId.length > 0 ? accountId : null
	} catch {
		return null
	}
}

// PKCE (RFC 7636) via Web Crypto — same output as the CLI flow.
async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
	return { verifier, challenge: base64url(new Uint8Array(digest)) }
}

function base64url(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function page(message: string): string {
	return `<!doctype html><meta charset="utf-8"><title>OpenAI sign-in</title><body style="font-family:system-ui;padding:2rem"><p>${message}</p></body>`
}
