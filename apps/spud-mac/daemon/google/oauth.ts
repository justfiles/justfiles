// Google's loopback OAuth (the "Desktop app" / installed-app flow): open the
// browser to the consent screen, catch the redirect on an ephemeral 127.0.0.1
// port, exchange the code (PKCE, no pre-registered port needed for a Desktop
// client). Runs in the daemon because a sandboxed reducer can't bind a port or
// open a browser. The fetch-based half (token exchange/refresh, authedFetch, the
// Gmail/Calendar clients) lives in `@justfiles/app/capabilities/accounts/providers/google`.
//
// The OAuth client id/secret come from the environment — a Desktop client's
// "secret" isn't truly confidential, but Google still wants it on the token call,
// so it stays out of the repo. Missing creds fail fast with a clear message.

import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import {
	type GoogleClient,
	type GoogleCreds,
	googleExchange
} from '@justfiles/app/capabilities/accounts/providers/google'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
// Always requested: the identity scopes that yield the account's email (the
// accountId) from the id_token. Capability scopes widen on top of these.
const IDENTITY_SCOPES = ['openid', 'email']
const FLOW_TIMEOUT_MS = 5 * 60_000

// Client creds from the environment, or null when unset — the provider can still
// be listed/refresh-skipped; the loopback `signIn` below fails clearly at connect.
export function googleClient(): GoogleClient | null {
	const id = process.env.GOOGLE_OAUTH_CLIENT_ID
	const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
	return id && secret ? { id, secret } : null
}

const base64url = (b: Buffer): string => b.toString('base64url')

// Run the consent flow for the union of identity + `requested` scopes, returning
// the tokens, the account's email, and the scopes Google actually granted (which
// the accounts store records to drive incremental consent).
export async function googleSignIn(
	requested: string[]
): Promise<{ accountId: string; creds: GoogleCreds; scopes: string[] }> {
	const client = googleClient()
	if (!client)
		throw new Error(
			'Google sign-in needs GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in the environment'
		)
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

	const token = await googleExchange(client, {
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
