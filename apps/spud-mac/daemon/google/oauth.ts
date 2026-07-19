// The daemon's interactive-auth user agent: a loopback AuthFlow (the "Desktop app" /
// installed-app OAuth shape). One authorize() round-trip = one one-shot server on an
// OS-assigned 127.0.0.1 port, whose URI the provider bakes into its authorize URL;
// the default browser is opened on that URL and the first request to land is the
// redirect, returned whole for the provider to validate (state, code, error). Runs in
// the daemon because a sandboxed reducer can't bind a port or open a browser. All
// protocol logic (PKCE, exchange, scopes) lives with the provider
// (@justfiles/app/capabilities/accounts/providers/google).
//
// The OAuth client id/secret come from the environment — a Desktop client's
// "secret" isn't truly confidential, but Google still wants it on the token call,
// so it stays out of the repo. Missing creds fail fast with a clear message.

import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import type { AuthFlow, GoogleClient } from '@justfiles/app/capabilities/accounts/providers'

const FLOW_TIMEOUT_MS = 5 * 60_000

// Client creds from the environment, or null when unset — the provider can still be
// listed and refresh-skipped; connect then fails clearly (see the google provider).
export function googleClient(): GoogleClient | null {
	const id = process.env.GOOGLE_OAUTH_CLIENT_ID
	const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
	return id && secret ? { id, secret } : null
}

export function loopbackAuthFlow(): AuthFlow {
	return {
		authorize: (buildUrl, opts) =>
			new Promise((resolve, reject) => {
				let redirectUri = ''
				const timer = setTimeout(() => {
					stop(() => reject(new Error('Sign-in timed out')))
				}, FLOW_TIMEOUT_MS)
				const stop = (fn: () => void) => {
					clearTimeout(timer)
					server.close()
					fn()
				}
				const server = createServer((req, res) => {
					res.writeHead(200, { 'content-type': 'text/html' })
					res.end('<!doctype html><title>Signed in</title>Signed in. You can close this tab.')
					stop(() => resolve(new URL(req.url ?? '/', redirectUri)))
				})
				opts?.signal?.addEventListener(
					'abort',
					() => stop(() => reject(new Error('sign-in cancelled'))),
					{ once: true }
				)
				server.on('error', (e) => {
					clearTimeout(timer)
					reject(e)
				})
				server.listen(0, '127.0.0.1', () => {
					const addr = server.address()
					if (typeof addr !== 'object' || !addr) {
						stop(() => reject(new Error('Could not bind a loopback port for sign-in')))
						return
					}
					redirectUri = `http://127.0.0.1:${addr.port}`
					// buildUrl may refuse (e.g. missing client creds) — reject, don't crash.
					try {
						execFile('open', [buildUrl(redirectUri)], () => {})
					} catch (err) {
						stop(() => reject(err instanceof Error ? err : new Error(String(err))))
					}
				})
			})
	}
}
