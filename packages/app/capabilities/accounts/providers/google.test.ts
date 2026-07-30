// The Google provider's token handling: the refresh token is the account and lives in
// the record; the access token is derived, lives in memory, and never reaches disk.
// Every test drives the REAL bindings against a stubbed Google, and asserts on the two
// observable seams — what reaches `persist`, and how many token exchanges happen.

import { afterEach, describe, expect, test, vi } from 'vitest'
import type { AuthFlow, BoundAccount } from '../provider.ts'
import { type GoogleClient, type GoogleCreds, googleProvider } from './google.ts'

const CLIENT: GoogleClient = { id: 'cid', secret: 'csec' }
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

const neverFlow: AuthFlow = {
	authorize: async () => {
		throw new Error('no interactive flow in this test')
	}
}

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200 })
}

// A stubbed Google: every token exchange is recorded (with its form body), every API
// call records the bearer it carried. Access tokens are minted `fresh-1`, `fresh-2`, …
// so a test can tell which exchange a request is using.
function stubGoogle(opts: { apiStatus?: number; rotateRefreshTo?: string } = {}) {
	const calls = { exchanges: [] as URLSearchParams[], bearers: [] as (string | undefined)[] }
	vi.stubGlobal(
		'fetch',
		async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
			if (url === TOKEN_URL) {
				calls.exchanges.push(new URLSearchParams(init?.body ?? ''))
				const body: Record<string, unknown> = {
					access_token: `fresh-${calls.exchanges.length}`,
					expires_in: 3600,
					id_token: idToken('me@gmail.com'),
					scope: 'openid email'
				}
				if (opts.rotateRefreshTo) body.refresh_token = opts.rotateRefreshTo
				return json(body)
			}
			calls.bearers.push(init?.headers?.authorization)
			if (opts.apiStatus) return new Response('denied', { status: opts.apiStatus })
			return json({ messages: [] })
		}
	)
	return calls
}

// One host process: a provider instance plus the clients bound over it. `persisted`
// collects every record written back, in order.
function host(client: GoogleClient | null = CLIENT, flow: AuthFlow = neverFlow) {
	const provider = googleProvider({ flow, client })
	const persisted: unknown[] = []
	const account = (creds: GoogleCreds): BoundAccount => ({
		creds,
		persist: async (next) => {
			persisted.push(next)
		}
	})
	return {
		persisted,
		acquire: (scopes: string[] = []) => provider.auth.acquire({ scopes }),
		// A freshly bound email client — what the host does on every capability call.
		bindEmail: (creds: GoogleCreds) => provider.capabilities.email!.bind(account(creds))
	}
}

// A minimal id_token: only the payload's `email` is read.
function idToken(email: string): string {
	const payload = btoa(JSON.stringify({ email }))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '')
	return `header.${payload}.signature`
}

const REFRESH_ONLY: GoogleCreds = { refresh: 'R', accountId: 'me@gmail.com' }

afterEach(() => vi.unstubAllGlobals())

describe('Google provider — the record holds the refresh token only', () => {
	test('a refresh persists { refresh, accountId } and no access token', async () => {
		const calls = stubGoogle()
		const { bindEmail, persisted } = host()
		await bindEmail(REFRESH_ONLY).listUnread({})
		expect(calls.exchanges).toHaveLength(1)
		expect(persisted).toEqual([{ refresh: 'R', accountId: 'me@gmail.com' }])
		expect(persisted[0]).not.toHaveProperty('access')
		expect(persisted[0]).not.toHaveProperty('expires')
	})

	test('a refresh-only record works: one exchange, then the call succeeds', async () => {
		const calls = stubGoogle()
		const { bindEmail } = host()
		expect(await bindEmail(REFRESH_ONLY).listUnread({})).toEqual([])
		expect(calls.exchanges).toHaveLength(1)
		expect(calls.exchanges[0]?.get('grant_type')).toBe('refresh_token')
		expect(calls.exchanges[0]?.get('refresh_token')).toBe('R')
		expect(calls.bearers).toEqual(['Bearer fresh-1'])
	})

	test('a rotated refresh token is persisted', async () => {
		stubGoogle({ rotateRefreshTo: 'R2' })
		const { bindEmail, persisted } = host()
		await bindEmail(REFRESH_ONLY).listUnread({})
		expect(persisted).toEqual([{ refresh: 'R2', accountId: 'me@gmail.com' }])
	})

	test('connecting stores no access token, and the first call reuses the acquired one', async () => {
		const flow: AuthFlow = {
			authorize: async (buildUrl) => {
				const state = new URL(buildUrl('http://127.0.0.1:1/cb')).searchParams.get('state')
				return new URL(`http://127.0.0.1:1/cb?code=CODE&state=${state}`)
			}
		}
		const calls = stubGoogle({ rotateRefreshTo: 'R-new' })
		const { acquire, bindEmail, persisted } = host(CLIENT, flow)
		const acquired = await acquire()
		expect(acquired.accountId).toBe('me@gmail.com')
		expect(acquired.creds).toEqual({ refresh: 'R-new', accountId: 'me@gmail.com' })
		// The token that came back from the code exchange is in memory, so using the
		// account it just created costs no second exchange.
		await bindEmail(acquired.creds as GoogleCreds).listUnread({})
		expect(calls.exchanges).toHaveLength(1)
		expect(calls.bearers).toEqual(['Bearer fresh-1'])
		expect(persisted).toEqual([])
	})
})

describe('Google provider — the access token lives in memory', () => {
	test('two calls on one bound client share a single exchange', async () => {
		const calls = stubGoogle()
		const { bindEmail } = host()
		const impl = bindEmail(REFRESH_ONLY)
		await impl.listUnread({})
		await impl.listUnread({})
		expect(calls.exchanges).toHaveLength(1)
		expect(calls.bearers).toEqual(['Bearer fresh-1', 'Bearer fresh-1'])
	})

	test('a second client bound in the same process reuses the live token', async () => {
		const calls = stubGoogle()
		const { bindEmail, persisted } = host()
		await bindEmail(REFRESH_ONLY).listUnread({})
		await bindEmail(REFRESH_ONLY).listUnread({})
		expect(calls.exchanges).toHaveLength(1)
		expect(calls.bearers).toEqual(['Bearer fresh-1', 'Bearer fresh-1'])
		expect(persisted).toHaveLength(1)
	})

	test('a cold process exchanges once, per account', async () => {
		const calls = stubGoogle()
		await host().bindEmail(REFRESH_ONLY).listUnread({})
		await host().bindEmail(REFRESH_ONLY).listUnread({})
		expect(calls.exchanges).toHaveLength(2)
	})
})

describe('Google provider — legacy records with a stored access token', () => {
	test('an unexpired stored token is used as-is (no exchange)', async () => {
		const calls = stubGoogle()
		const { bindEmail, persisted } = host()
		await bindEmail({
			...REFRESH_ONLY,
			access: 'legacy',
			expires: Date.now() + 3_600_000
		}).listUnread({})
		expect(calls.exchanges).toHaveLength(0)
		expect(calls.bearers).toEqual(['Bearer legacy'])
		expect(persisted).toEqual([])
	})

	test('the next refresh drops the legacy keys (migration by attrition)', async () => {
		stubGoogle()
		const { bindEmail, persisted } = host()
		await bindEmail({ ...REFRESH_ONLY, access: 'legacy', expires: Date.now() - 1 }).listUnread({})
		expect(persisted).toEqual([{ refresh: 'R', accountId: 'me@gmail.com' }])
	})
})

describe('Google provider — no OAuth client configured', () => {
	test('no refresh is attempted; a 401 surfaces for re-auth', async () => {
		const calls = stubGoogle({ apiStatus: 401 })
		const { bindEmail, persisted } = host(null)
		await expect(
			bindEmail({ ...REFRESH_ONLY, access: 'stale', expires: Date.now() - 1 }).listUnread({})
		).rejects.toThrow('Google API 401')
		expect(calls.exchanges).toHaveLength(0)
		expect(calls.bearers).toEqual(['Bearer stale'])
		expect(persisted).toEqual([])
	})
})
