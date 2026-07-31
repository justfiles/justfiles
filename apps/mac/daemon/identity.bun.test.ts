// E1: the daemon's Kodama identity — an OAuth public client of our Clerk instance.
// Bun-only (`Bun.serve` for the stub authorization server, and the real `security` CLI for
// the one custody test), like the daemon's other `*.bun.test.ts` files.
//
// The stub server stands in for Clerk's FAPI: `/oauth/token` and `/oauth/token/revoke` are
// the only endpoints this module talks to, plus `/oauth/authorize`, which never reaches the
// network here (the fake AuthFlow answers it, exactly as the loopback listener does).

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuthFlow } from '@justfiles/app/capabilities/accounts/providers'
import { createIdentity, type IdentityDeps } from './identity.ts'
import { keychainStore, type SecretStore } from './keychain.ts'

const CLIENT_ID = 'test-client'
const USER = 'user_test123'

// A token shaped like Clerk's: `typ: at+jwt`, `sub` = the Clerk user id. Never verified here
// (the worker does that) — the daemon only reads `sub`.
const accessToken = (n: number, sub = USER): string => {
	const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
	return `${part({ alg: 'RS256', typ: 'at+jwt' })}.${part({ sub, jti: `oat_${n}` })}.sig-${n}`
}

interface Call {
	path: string
	body: URLSearchParams
}

type Reply = (body: URLSearchParams) => Response

function stubAuthServer() {
	const calls: Call[] = []
	let issued = 0
	// A grant: a fresh access token and a ROTATED refresh token, which is what Clerk does.
	const mint = (expiresIn: number) =>
		Response.json({
			access_token: accessToken(++issued),
			refresh_token: `rt-${issued}`,
			expires_in: expiresIn,
			token_type: 'bearer'
		})
	let reply: Reply = () => mint(86_400)
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: async (req) => {
			const url = new URL(req.url)
			const body = new URLSearchParams(await req.text())
			calls.push({ path: url.pathname, body })
			if (url.pathname === '/oauth/token/revoke') return new Response(null, { status: 200 })
			if (url.pathname === '/oauth/userinfo') return Response.json({ name: 'Test User' })
			return reply(body)
		}
	})
	return {
		fapi: server.url.origin,
		calls,
		tokenCalls: () => calls.filter((c) => c.path === '/oauth/token'),
		// Grants from here on live `expiresIn` seconds.
		rotating: (expiresIn: number) => {
			reply = () => mint(expiresIn)
		},
		serve: (next: Reply) => {
			reply = next
		},
		stop: () => server.stop(true)
	}
}

// An in-memory SecretStore: the same contract as the Keychain one, so every test but the
// custody test runs without touching the machine's Keychain.
function memoryStore(initial?: string): SecretStore & { value?: string; failWrites?: boolean } {
	const store = {
		value: initial,
		failWrites: false,
		read: async () => store.value,
		write: async (value: string) => {
			if (store.failWrites) throw new Error('keychain: locked')
			store.value = value
		},
		remove: async () => {
			store.value = undefined
		}
	}
	return store
}

// The loopback listener, minus the port and the browser: whatever URL the module builds, the
// "browser" comes back to its `redirect_uri` with a code and the state it was given.
function fakeBrowser(): AuthFlow & { authorizeUrl?: URL } {
	const flow = {
		authorizeUrl: undefined as URL | undefined,
		authorize: async (buildUrl: (redirectUri: string) => string) => {
			const url = new URL(buildUrl('http://127.0.0.1:49152'))
			flow.authorizeUrl = url
			const back = new URL(url.searchParams.get('redirect_uri') ?? '')
			back.searchParams.set('code', 'auth-code-1')
			back.searchParams.set('state', url.searchParams.get('state') ?? '')
			return back
		}
	}
	return flow
}

let server: ReturnType<typeof stubAuthServer>

beforeEach(() => {
	server = stubAuthServer()
})
afterEach(() => {
	server.stop()
})

const identityOver = (store: SecretStore, flow: AuthFlow = fakeBrowser()) =>
	createIdentity({ fapi: server.fapi, clientId: CLIENT_ID, flow, store } satisfies IdentityDeps)

test('signed out: getToken() resolves null and never throws', async () => {
	const identity = identityOver(memoryStore())
	expect(await identity.getToken()).toBeNull()
	expect(await identity.currentUser()).toBeNull()
	expect(server.tokenCalls()).toHaveLength(0)
})

test('sign-in exchanges the code with PKCE and no client secret, and stores the refresh token', async () => {
	const store = memoryStore()
	const flow = fakeBrowser()
	const identity = identityOver(store, flow)

	const user = await identity.signIn()
	expect(user.id).toBe(USER)

	// The authorize URL: a public client's code flow, on the loopback path Clerk has
	// registered (the port varies — Clerk ignores it for 127.0.0.1, RFC 8252 §7.3).
	const authorize = flow.authorizeUrl
	expect(authorize?.pathname).toBe('/oauth/authorize')
	expect(authorize?.searchParams.get('response_type')).toBe('code')
	expect(authorize?.searchParams.get('code_challenge_method')).toBe('S256')
	expect(authorize?.searchParams.get('code_challenge')).toBeTruthy()
	expect(authorize?.searchParams.get('scope')).toContain('offline_access')
	expect(authorize?.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:49152/auth/callback')

	// The exchange: `code_verifier` instead of a secret we could not keep anyway.
	const [exchange] = server.tokenCalls()
	expect(exchange.body.get('grant_type')).toBe('authorization_code')
	expect(exchange.body.get('code_verifier')).toBeTruthy()
	expect(exchange.body.get('client_secret')).toBeNull()
	expect(exchange.body.get('redirect_uri')).toBe('http://127.0.0.1:49152/auth/callback')

	// The refresh token is the thing kept; the access token is live in memory.
	expect(store.value).toBe('rt-1')
	expect(await identity.getToken()).toBe(accessToken(1))
})

test('a cached token serves repeat calls — one network hit, not two', async () => {
	const identity = identityOver(memoryStore('rt-0'))
	expect(await identity.getToken()).toBe(accessToken(1))
	expect(await identity.getToken()).toBe(accessToken(1))
	expect(server.tokenCalls()).toHaveLength(1)
})

test('a token near expiry is refreshed, and the rotated refresh token replaces the old one', async () => {
	const store = memoryStore('rt-0')
	server.rotating(60) // 60s left ⇒ inside the refresh window on arrival
	const identity = identityOver(store)

	expect(await identity.getToken()).toBe(accessToken(1))
	expect(store.value).toBe('rt-1')
	// The next call must not reuse a token that is about to die.
	expect(await identity.getToken()).toBe(accessToken(2))
	expect(store.value).toBe('rt-2')
	expect(server.tokenCalls()[1].body.get('refresh_token')).toBe('rt-1')
})

test('single-flight: 20 concurrent callers cause ONE refresh (a second would kill the grant)', async () => {
	const identity = identityOver(memoryStore('rt-0'))
	const results = await Promise.all(Array.from({ length: 20 }, () => identity.getToken()))
	expect(new Set(results)).toEqual(new Set([accessToken(1)]))
	expect(server.tokenCalls()).toHaveLength(1)
})

test('400 invalid_grant ⇒ signed out: the credential is cleared, not retried forever', async () => {
	const store = memoryStore('rt-revoked')
	server.serve(() => Response.json({ error: 'invalid_grant' }, { status: 400 }))
	const identity = identityOver(store)

	const seen: (string | null)[] = []
	identity.onChange((user) => seen.push(user?.id ?? null))

	expect(await identity.getToken()).toBeNull()
	expect(store.value).toBeUndefined()
	expect(seen).toEqual([null])
})

test('a transient failure keeps the credential — offline must not sign the user out', async () => {
	const store = memoryStore('rt-0')
	server.serve(() => new Response('bad gateway', { status: 502 }))
	const identity = identityOver(store)

	expect(await identity.getToken()).toBeNull()
	expect(store.value).toBe('rt-0') // still signed in, just unreachable

	// …and the next attempt heals without a re-sign-in.
	server.rotating(86_400)
	expect(await identity.getToken()).toBe(accessToken(1))
	expect(store.value).toBe('rt-1')
})

test('an unreachable authorization server is a transient failure, not a sign-out', async () => {
	const store = memoryStore('rt-0')
	const identity = createIdentity({
		fapi: 'http://127.0.0.1:1', // nothing listens here
		clientId: CLIENT_ID,
		flow: fakeBrowser(),
		store
	})
	expect(await identity.getToken()).toBeNull()
	expect(store.value).toBe('rt-0')
})

test('persist-then-use: a rotation we cannot record is never handed out', async () => {
	// The rotated token is already dead server-side, so using the new access token while
	// having lost its refresh token means the NEXT refresh silently kills the grant.
	const store = memoryStore('rt-0')
	store.failWrites = true
	const identity = identityOver(store)

	expect(await identity.getToken()).toBeNull()
	expect(store.value).toBe('rt-0')
})

test('sign-out revokes the grant, drops the item, and leaves local data alone', async () => {
	const store = memoryStore()
	const identity = identityOver(store)
	await identity.signIn()

	const support = await mkdtemp(join(tmpdir(), 'kodama-support-'))
	await Bun.write(join(support, 'volume', 'notes', 'keep.md'), 'local content')
	await identity.signOut()

	expect(store.value).toBeUndefined()
	expect(await identity.getToken()).toBeNull()
	expect(await identity.currentUser()).toBeNull()
	expect(server.calls.some((c) => c.path === '/oauth/token/revoke')).toBe(true)
	expect(await readFile(join(support, 'volume', 'notes', 'keep.md'), 'utf8')).toBe('local content')
	await rm(support, { recursive: true, force: true })
})

test('no token of any kind reaches the support dir', async () => {
	const prev = process.env.FRIEREN_SUPPORT_DIR
	const support = await mkdtemp(join(tmpdir(), 'kodama-support-'))
	process.env.FRIEREN_SUPPORT_DIR = support
	try {
		const store = memoryStore()
		const identity = identityOver(store)
		server.rotating(60)
		await identity.signIn()
		await identity.getToken() // and a rotation on top of the sign-in

		const files = await readdir(support, { recursive: true, withFileTypes: true })
		for (const entry of files.filter((f) => f.isFile())) {
			const text = await readFile(join(entry.parentPath, entry.name), 'utf8')
			expect(text).not.toContain(accessToken(1))
			expect(text).not.toContain('rt-1')
		}
	} finally {
		if (prev === undefined) delete process.env.FRIEREN_SUPPORT_DIR
		else process.env.FRIEREN_SUPPORT_DIR = prev
		await rm(support, { recursive: true, force: true })
	}
})

// The one test that really goes to the Keychain, under a test-scoped service name so it can
// never touch the daemon's own `app.justfiles.kodama` items.
const SERVICE = `app.justfiles.kodama.test.${Date.now()}`
afterAll(() => {
	Bun.spawnSync(['security', 'delete-generic-password', '-s', SERVICE, '-a', 'kodama-oauth'])
})

test('custody is the Keychain: sign-in writes the item, sign-out deletes it', async () => {
	const store = keychainStore('kodama-oauth', SERVICE)
	const identity = identityOver(store)
	server.rotating(60) // so the next getToken() really refreshes
	await identity.signIn()

	const held = () =>
		Bun.spawnSync(['security', 'find-generic-password', '-s', SERVICE, '-a', 'kodama-oauth', '-w'])
	expect(held().stdout.toString().trim()).toBe('rt-1')

	// A rotation updates the same item in place rather than piling up duplicates.
	await identity.getToken()
	expect(held().stdout.toString().trim()).toBe('rt-2')

	await identity.signOut()
	expect(held().exitCode).toBe(44) // no such item
	expect(await identity.getToken()).toBeNull()
})
