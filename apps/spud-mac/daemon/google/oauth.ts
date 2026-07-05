// Google's loopback OAuth (the "Desktop app" / installed-app flow): open the
// browser to the consent screen, catch the redirect on an ephemeral 127.0.0.1
// port, exchange the code (PKCE, no pre-registered port needed for a Desktop
// client), and refresh the same way ChatGPT does in chatgpt.ts. Runs in the
// daemon because a sandboxed reducer can't bind a port or open a browser.
//
// The OAuth client id/secret come from the environment — a Desktop client's
// "secret" isn't truly confidential, but Google still wants it on the token call,
// so it stays out of the repo. Missing creds fail fast with a clear message.

import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { Creds } from '@justfiles/app/capabilities/accounts/host'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
// Always requested: the identity scopes that yield the account's email (the
// accountId) from the id_token. Capability scopes widen on top of these.
const IDENTITY_SCOPES = ['openid', 'email']
const FLOW_TIMEOUT_MS = 5 * 60_000

// What an account from this provider stores. `expires` is epoch ms.
export interface GoogleCreds extends Creds {
	access: string
	refresh: string
	expires: number
	accountId: string
}

interface ClientCreds {
	id: string
	secret: string
}

function clientCreds(): ClientCreds {
	const id = process.env.GOOGLE_OAUTH_CLIENT_ID
	const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
	if (!id || !secret) {
		throw new Error(
			'Google sign-in needs GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in the environment'
		)
	}
	return { id, secret }
}

const base64url = (b: Buffer): string => b.toString('base64url')

// Run the consent flow for the union of identity + `requested` scopes, returning
// the tokens, the account's email, and the scopes Google actually granted (which
// the accounts store records to drive incremental consent).
export async function googleSignIn(
	requested: string[]
): Promise<{ accountId: string; creds: GoogleCreds; scopes: string[] }> {
	const client = clientCreds()
	const verifier = base64url(randomBytes(32))
	const challenge = base64url(createHash('sha256').update(verifier).digest())
	const state = base64url(randomBytes(16))
	const scope = [...new Set([...IDENTITY_SCOPES, ...requested])].join(' ')

	const { code, redirectUri } = await catchRedirect(state, (redirectUri) => {
		const url = new URL(AUTH_URL)
		url.search = new URLSearchParams({
			client_id: client.id,
			redirect_uri: redirectUri,
			response_type: 'code',
			scope,
			code_challenge: challenge,
			code_challenge_method: 'S256',
			access_type: 'offline',
			include_granted_scopes: 'true',
			prompt: 'consent',
			state
		}).toString()
		execFile('open', [url.toString()], () => {})
	})

	const token = await exchange(client, {
		grant_type: 'authorization_code',
		code,
		redirect_uri: redirectUri,
		code_verifier: verifier
	})
	const accountId = emailFromIdToken(token.id_token) ?? ''
	return {
		accountId,
		creds: {
			access: token.access_token,
			refresh: token.refresh_token ?? '',
			expires: Date.now() + token.expires_in * 1000,
			accountId
		},
		scopes: (token.scope ?? scope).split(' ').filter(Boolean)
	}
}

// Exchange the long-lived refresh token for a fresh access token (a plain POST,
// no browser). Google omits `refresh_token` on refresh, so the old one carries.
export async function googleRefresh(creds: GoogleCreds): Promise<GoogleCreds> {
	const token = await exchange(clientCreds(), {
		grant_type: 'refresh_token',
		refresh_token: creds.refresh
	})
	return {
		access: token.access_token,
		refresh: token.refresh_token ?? creds.refresh,
		expires: Date.now() + token.expires_in * 1000,
		accountId: creds.accountId
	}
}

interface TokenResponse {
	access_token: string
	refresh_token?: string
	expires_in: number
	id_token?: string
	scope?: string
}

async function exchange(
	client: ClientCreds,
	params: Record<string, string>
): Promise<TokenResponse> {
	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: client.id,
			client_secret: client.secret,
			...params
		}).toString()
	})
	if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`)
	return (await res.json()) as TokenResponse
}

// Start a one-shot loopback server on an OS-assigned port, hand its redirect URI
// to `open` (which launches the browser), and resolve with the caught auth code.
function catchRedirect(
	state: string,
	open: (redirectUri: string) => void
): Promise<{ code: string; redirectUri: string }> {
	return new Promise((resolve, reject) => {
		let redirectUri = ''
		const timer = setTimeout(() => {
			server.close()
			reject(new Error('Google sign-in timed out'))
		}, FLOW_TIMEOUT_MS)
		const done = (fn: () => void) => {
			clearTimeout(timer)
			server.close()
			fn()
		}
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? '/', redirectUri)
			res.writeHead(200, { 'content-type': 'text/html' })
			res.end('<!doctype html><title>Signed in</title>Signed in. You can close this tab.')
			const code = url.searchParams.get('code')
			if (code && url.searchParams.get('state') === state) {
				done(() => resolve({ code, redirectUri }))
			} else if (url.searchParams.has('error') || url.searchParams.has('state')) {
				done(() => reject(new Error('Google sign-in failed or was cancelled')))
			}
		})
		server.on('error', (e) => {
			clearTimeout(timer)
			reject(e)
		})
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address()
			if (typeof addr !== 'object' || !addr) {
				done(() => reject(new Error('Could not bind a loopback port for Google sign-in')))
				return
			}
			redirectUri = `http://127.0.0.1:${addr.port}`
			open(redirectUri)
		})
	})
}

function emailFromIdToken(idToken: string | undefined): string | undefined {
	const payload = idToken?.split('.')[1]
	if (!payload) return undefined
	try {
		return (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { email?: string }).email
	} catch {
		return undefined
	}
}

export type AuthedFetch = (
	path: string,
	init?: { method?: string; body?: string }
) => Promise<Response>

// A bearer-attaching fetch over an account's creds, refreshing once on near
// expiry. Mint has no store, so the rotated token isn't persisted — the next
// capability call refreshes again; a failed refresh falls through to a 401 that
// surfaces as re-auth, the same posture chatgpt.ts documents.
export function authedFetch(creds: GoogleCreds): AuthedFetch {
	let access = creds.access
	let refreshed = false
	return async (path, init = {}) => {
		if (!refreshed && creds.refresh && creds.expires - Date.now() < 60_000) {
			refreshed = true
			try {
				access = (await googleRefresh(creds)).access
			} catch {
				// keep the stale token; the request below 401s into re-auth
			}
		}
		const res = await fetch(path, {
			method: init.method,
			body: init.body,
			headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }
		})
		if (!res.ok) throw new Error(`Google API ${res.status}: ${await res.text()}`)
		return res
	}
}
