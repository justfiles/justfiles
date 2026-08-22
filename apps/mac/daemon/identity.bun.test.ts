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
import { createIdentity, custodyAccount, type IdentityDeps } from './identity.ts'
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

type Reply = (body: URLSearchParams) => Response | Promise<Response>

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
	let gate: { path: string; held: Promise<void> } | undefined
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: async (req) => {
			const url = new URL(req.url)
			const body = new URLSearchParams(await req.text())
			calls.push({ path: url.pathname, body })
			if (gate?.path === url.pathname) await gate.held
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
		// Hold responses for one endpoint until the returned function is called — how the sign-out
		// races below pin an operation mid-flight. Scoped to a path so sign-out's own revoke still
		// gets through (gating everything would just deadlock the test).
		hold: (path: string) => {
			let release = () => {}
			const held = new Promise<void>((resolve) => {
				release = resolve
			})
			gate = { path, held }
			return () => {
				gate = undefined
				release()
			}
		},
		stop: () => server.stop(true)
	}
}

// An in-memory SecretStore: the same contract as the Keychain one, so every test but the
// custody test runs without touching the machine's Keychain. `failReads` is the locked/denied
// Keychain — a read that THROWS, which is not the same as an empty one. `delay` makes a
// Keychain call slow (a list is consumed per call), which is how the interleaving tests get an
// operation to LAND late rather than merely start late — the difference between a race that
// fails and one that never fires.
type Delay = number | number[]
function memoryStore(initial?: string): SecretStore & {
	value?: string
	failWrites?: boolean
	failReads?: boolean
	delay: { read: Delay; write: Delay; remove: Delay }
} {
	const wait = async (delay: Delay) => {
		const ms = Array.isArray(delay) ? (delay.shift() ?? 0) : delay
		if (ms) await Bun.sleep(ms)
	}
	const store = {
		value: initial,
		failWrites: false,
		failReads: false,
		delay: { read: 0 as Delay, write: 0 as Delay, remove: 0 as Delay },
		read: async () => {
			await wait(store.delay.read)
			if (store.failReads) throw new Error('keychain: could not read (security exit 51)')
			return store.value
		},
		write: async (value: string) => {
			await wait(store.delay.write)
			if (store.failWrites) throw new Error('keychain: locked')
			store.value = value
		},
		remove: async () => {
			await wait(store.delay.remove)
			store.value = undefined
		}
	}
	return store
}

// The loopback listener, minus the port and the browser: whatever URL the module builds, the
// "browser" comes back to its `redirect_uri` with a code and the state it was given. Set
// `cancel` to stand in for a user who closes the tab.
function fakeBrowser(): AuthFlow & { authorizeUrl?: URL; cancel?: boolean } {
	const flow = {
		authorizeUrl: undefined as URL | undefined,
		cancel: false,
		authorize: async (buildUrl: (redirectUri: string) => string) => {
			const url = new URL(buildUrl('http://127.0.0.1:49152'))
			flow.authorizeUrl = url
			if (flow.cancel) throw new Error('sign-in cancelled')
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

const identityOver = (store: SecretStore, flow: AuthFlow = fakeBrowser(), timeoutMs?: number) =>
	createIdentity({
		fapi: server.fapi,
		clientId: CLIENT_ID,
		flow,
		store,
		timeoutMs
	} satisfies IdentityDeps)

test('signed out: getToken() resolves null and never throws', async () => {
	const identity = identityOver(memoryStore())
	expect(await identity.getToken()).toBeNull()
	expect(await identity.currentUser()).toBeNull()
	expect(await identity.ownerId()).toBeNull()
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
	expect(await identity.ownerId()).toBeUndefined()

	// …and the next attempt heals without a re-sign-in.
	server.rotating(86_400)
	expect(await identity.getToken()).toBe(accessToken(1))
	expect(store.value).toBe('rt-1')
	expect(await identity.ownerId()).toBe(USER)
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

test('sign-out during an in-flight refresh does not resurrect the grant', async () => {
	// The refresh has already spent the stored token server-side by the time sign-out runs, so
	// the danger is the reply landing afterwards: writing the rotated token back into the
	// Keychain and republishing the user signs the daemon back in behind the user's back.
	const store = memoryStore('rt-0')
	const identity = identityOver(store)
	const seen: (string | null)[] = []
	identity.onChange((user) => seen.push(user?.id ?? null))

	const release = server.hold('/oauth/token')
	const pending = identity.getToken()
	await Bun.sleep(20) // the refresh is out on the wire
	await identity.signOut()
	release()

	expect(await pending).toBeNull()
	expect(store.value).toBeUndefined()
	expect(await identity.getToken()).toBeNull()
	expect(await identity.currentUser()).toBeNull()
	expect(seen).toEqual([null]) // never a user
})

test('sign-out during a profile fetch does not republish the user', async () => {
	const store = memoryStore()
	const identity = identityOver(store)
	await identity.signIn()

	const release = server.hold('/oauth/userinfo')
	const pending = identity.currentUser() // in `describe`, waiting on /oauth/userinfo
	await Bun.sleep(20)
	await identity.signOut()
	release()

	await pending
	expect(await identity.currentUser()).toBeNull()
	expect(store.value).toBeUndefined()
})

test('a sign-in fences the old grant: a late refresh cannot overwrite or delete the new one', async () => {
	const store = memoryStore('rt-old')
	const identity = identityOver(store)
	// The old grant's refresh is SLOW, so it lands after the sign-in has already stored its own
	// grant — the ordering that makes this a bug rather than a curiosity.
	server.serve(async (body) => {
		if (body.get('grant_type') === 'refresh_token') {
			await Bun.sleep(150)
			return Response.json({
				access_token: accessToken(1),
				refresh_token: 'rt-stale',
				expires_in: 86_400
			})
		}
		return Response.json({
			access_token: accessToken(2),
			refresh_token: 'rt-new',
			expires_in: 86_400
		})
	})

	const stale = identity.getToken()
	await Bun.sleep(20)
	await identity.signIn() // possibly as somebody else
	await stale

	// The sign-in's grant is the one in custody, and its token is the one on offer.
	expect(store.value).toBe('rt-new')
	expect(await identity.getToken()).toBe(accessToken(2))
})

test('a late invalid_grant from the OLD grant does not delete the new one', async () => {
	// The dangerous version of the same race: the stale refresh comes back "revoked" and, without
	// the fence, cleared the Keychain item the sign-in had just stored — signing the user out of
	// an account they had just signed in to.
	const store = memoryStore('rt-old')
	const identity = identityOver(store)
	server.serve(async (body) => {
		if (body.get('grant_type') === 'refresh_token') {
			await Bun.sleep(150)
			return Response.json({ error: 'invalid_grant' }, { status: 400 })
		}
		return Response.json({
			access_token: accessToken(9),
			refresh_token: 'rt-new',
			expires_in: 86_400
		})
	})

	const stale = identity.getToken()
	await Bun.sleep(20)
	await identity.signIn()
	await stale

	expect(store.value).toBe('rt-new')
	expect(await identity.currentUser()).not.toBeNull()
})

// The three interleavings below are all the same shape: an operation belonging to the OLD
// grant is *already past* its generation check, with a Keychain call in flight, when a newer
// explicit action lands. Checking the fence before an `await` cannot catch these — only
// serialising custody can — so each one is delayed into the window that used to be unguarded.

test('a stale rotation cannot overwrite the grant a newer sign-in just stored', async () => {
	const store = memoryStore('rt-old')
	// The stale write is slow and the sign-in's is not, so the stale one LANDS LAST — the only
	// ordering in which it can clobber, and the one a fence around an await cannot prevent.
	store.delay.write = [120, 0]
	const identity = identityOver(store)
	server.serve((body) =>
		Response.json(
			body.get('grant_type') === 'refresh_token'
				? { access_token: accessToken(1), refresh_token: 'rt-stale', expires_in: 86_400 }
				: { access_token: accessToken(2), refresh_token: 'rt-new', expires_in: 86_400 }
		)
	)

	const stale = identity.getToken() // its write is in flight…
	await Bun.sleep(20)
	await identity.signIn() // …while this one stores the new grant
	await stale

	expect(store.value).toBe('rt-new')
	expect(await identity.getToken()).toBe(accessToken(2))
	expect((await identity.currentUser())?.id).toBe(USER)
})

test('a stale invalid_grant cannot delete the grant a newer sign-in just stored', async () => {
	const store = memoryStore('rt-old')
	store.delay.remove = 80
	const identity = identityOver(store)
	server.serve((body) =>
		body.get('grant_type') === 'refresh_token'
			? Response.json({ error: 'invalid_grant' }, { status: 400 })
			: Response.json({ access_token: accessToken(9), refresh_token: 'rt-new', expires_in: 86_400 })
	)

	const stale = identity.getToken() // its delete is in flight…
	await Bun.sleep(20)
	await identity.signIn() // …while this one stores the new grant
	await stale

	expect(store.value).toBe('rt-new')
	expect(await identity.getToken()).toBe(accessToken(9))
	expect((await identity.currentUser())?.id).toBe(USER)
})

test('an older sign-out cannot delete or revoke a newer sign-in', async () => {
	const store = memoryStore('rt-old')
	store.delay.read = 80
	const identity = identityOver(store)

	const out = identity.signOut() // its custody work is in flight…
	await Bun.sleep(20)
	await identity.signIn() // …while the user signs in again
	await out

	// The new grant survives, and — the sharp end — was never handed to Clerk to revoke.
	expect(store.value).toBe('rt-1')
	expect(await identity.getToken()).toBe(accessToken(1))
	expect((await identity.currentUser())?.id).toBe(USER)
	expect(server.calls.filter((c) => c.path === '/oauth/token/revoke')).toHaveLength(1)
	expect(server.calls.find((c) => c.path === '/oauth/token/revoke')?.body.get('token')).toBe(
		'rt-old'
	)
})

test('sign-out during a pending write cannot be undone when the write lands', async () => {
	// The adoption is what sign-out has to beat: the fence is checked before `store.write`, so a
	// sign-out landing DURING that write used to find its cleared token and published `null`
	// overwritten the moment the write resolved — signed out in the UI, cached token in memory,
	// custody deleted underneath it.
	const store = memoryStore('rt-0')
	store.delay.write = 80
	const identity = identityOver(store)
	const seen: (string | null)[] = []
	identity.onChange((user) => seen.push(user?.id ?? null))

	const pending = identity.getToken() // its write is in flight…
	await Bun.sleep(20)
	await identity.signOut() // …when the user signs out
	await pending

	expect(await identity.getToken()).toBeNull()
	expect(await identity.currentUser()).toBeNull()
	expect(store.value).toBeUndefined()
	expect(seen).toEqual([null]) // never a user
	// The grant that WAS live when sign-out ran is the one revoked — the rotation, not the token
	// it replaced.
	expect(server.calls.find((c) => c.path === '/oauth/token/revoke')?.body.get('token')).toBe('rt-1')
})

test('a pending profile fetch answers with the CURRENT identity, not the one it started with', async () => {
	// Settings' `host.user` is in flight when the user signs out. Answering with the profile the
	// call started with latches a signed-in pane until something reloads it — and the fetch is
	// long enough (a network round trip) for the sign-out to be entirely real by then.
	const store = memoryStore()
	const identity = identityOver(store)
	await identity.signIn()

	const release = server.hold('/oauth/userinfo')
	const pending = identity.currentUser()
	await Bun.sleep(20)
	await identity.signOut()
	release()

	expect(await pending).toBeNull()
})

test('a cancelled sign-in does not re-arm a grant an earlier sign-out failed to delete', async () => {
	// After a sign-out whose delete failed, `forgotten` is the ONLY thing keeping the leftover
	// credential unusable. Clearing it when sign-in STARTS means a cancelled browser flow hands
	// the old account back — silently, and as a different user than the one being signed in.
	const store = memoryStore()
	const flow = fakeBrowser()
	const identity = identityOver(store, flow)
	await identity.signIn()
	store.remove = async () => {
		throw new Error('keychain: could not delete (security exit 51)')
	}
	await expect(identity.signOut()).rejects.toThrow('the Keychain item remains')
	expect(store.value).toBeTruthy() // the old grant is still on disk

	// The user starts a sign-in and abandons it in the browser.
	flow.cancel = true
	await expect(identity.signIn()).rejects.toThrow('cancelled')

	// Still signed out: a sign-in that never reached a grant has earned nothing.
	expect(await identity.getToken()).toBeNull()
	expect(await identity.currentUser()).toBeNull()

	// And a sign-in that DOES complete re-arms it, because `adopt` commits `forgotten: false`.
	flow.cancel = false
	store.remove = async () => {
		store.value = undefined
	}
	expect((await identity.signIn()).id).toBe(USER)
	expect(await identity.getToken()).toBeTruthy()
})

test('a Clerk that accepts and never answers does not wedge every later caller', async () => {
	// `getToken()` memoises one refresh, so an unbounded request that never settles is worse than
	// a failing one: every capability call, sync tick and Settings pane joins the same dead fetch
	// for the life of the daemon. A timeout turns it back into an ordinary transient failure.
	const store = memoryStore('rt-0')
	const identity = identityOver(store, fakeBrowser(), 60)
	const release = server.hold('/oauth/token')

	expect(await identity.getToken()).toBeNull() // gives up instead of hanging
	expect(store.value).toBe('rt-0') // …and a timeout is transient, so custody stays

	// The memoised promise is gone with it, so the next call is a fresh attempt — which succeeds
	// once the server answers again (with a NEW grant: the abandoned request had already been
	// served, which is the trade this timeout accepts — see the note in identity.ts).
	release()
	expect(await identity.getToken()).toBeTruthy()
	expect(store.value).not.toBe('rt-0')
})

test('a Keychain that will not delete still signs the daemon out locally', async () => {
	// The delete is the one step that can fail AFTER the user asked to sign out. If it took the
	// in-memory clear with it, `getToken()` would keep answering for up to a day — signed out in
	// the UI, authenticated in fact — and `/sign-out` would never reply at all.
	const store = memoryStore()
	const identity = identityOver(store)
	await identity.signIn()
	expect(await identity.getToken()).toBeTruthy()

	store.remove = async () => {
		throw new Error('keychain: could not delete (security exit 51)')
	}
	// It reports the failure — the credential IS still on disk, and the user has to know — …
	await expect(identity.signOut()).rejects.toThrow('the Keychain item remains')
	// …but this daemon is signed out and STAYS signed out: re-minting tokens from a credential
	// the user asked us to forget is the one thing sign-out must never do, and the revoke means
	// what is left on disk is worthless anyway.
	expect(store.value).toBeTruthy() // the item really is still there
	expect(await identity.getToken()).toBeNull()
	expect(await identity.currentUser()).toBeNull()
	expect(server.calls.some((c) => c.path === '/oauth/token/revoke')).toBe(true)

	// A later sign-in re-arms it — "forget this" is not permanent, it is until asked otherwise.
	store.remove = async () => {
		store.value = undefined
	}
	expect((await identity.signIn()).id).toBe(USER)
	expect(await identity.getToken()).toBeTruthy()
})

test('sign-out clears custody BEFORE it waits on Clerk', async () => {
	// A revoke that stalls (rather than refusing) used to leave the item in the Keychain and
	// `getToken()` still answering, with `/sign-out` never replying — signed out in the UI,
	// authenticated in fact.
	const store = memoryStore()
	const identity = identityOver(store)
	await identity.signIn()
	expect(await identity.getToken()).toBeTruthy()

	const release = server.hold('/oauth/token/revoke')
	const pending = identity.signOut()
	await Bun.sleep(20) // still inside the stalled revoke

	expect(store.value).toBeUndefined()
	expect(await identity.getToken()).toBeNull()
	expect(await identity.currentUser()).toBeNull()

	release()
	await pending
})

test('a Keychain that cannot be read is transient, not "signed out"', async () => {
	// `security` failing for a locked keychain or a denied prompt is not an absent grant. Reading
	// it as one would publish "Local user" and cache it for the rest of the run.
	const store = memoryStore('rt-0')
	store.failReads = true
	const identity = identityOver(store)

	expect(await identity.getToken()).toBeNull() // and never throws
	expect(await identity.currentUser()).toBeNull()

	store.failReads = false
	expect(await identity.currentUser()).toEqual({
		id: USER,
		name: 'Test User',
		avatarUrl: undefined
	})
})

test('an offline first look does not cache "signed out" over a good grant', async () => {
	// The boot-with-no-network case: Settings asks who is signed in, the refresh fails
	// transiently, and caching that as "nobody" would keep saying "Local user" for the rest of
	// the run even though the Keychain still holds a working grant.
	const store = memoryStore('rt-0')
	server.serve(() => new Response('bad gateway', { status: 502 }))
	const identity = identityOver(store)

	expect(await identity.currentUser()).toBeNull()
	server.rotating(86_400)
	expect(await identity.currentUser()).toEqual({
		id: USER,
		name: 'Test User',
		avatarUrl: undefined
	})
})

test('signed out for real is cached: no grant means no repeat network calls', async () => {
	const identity = identityOver(memoryStore())
	expect(await identity.currentUser()).toBeNull()
	expect(await identity.currentUser()).toBeNull()
	expect(server.tokenCalls()).toHaveLength(0)
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
const PROD = custodyAccount('https://clerk.mykodama.app')
const DEV = custodyAccount('https://capable-spider-79.clerk.accounts.dev')
afterAll(() => {
	for (const account of ['kodama-oauth', PROD, DEV]) {
		Bun.spawnSync(['security', 'delete-generic-password', '-s', SERVICE, '-a', account])
	}
})

test('custody is namespaced per Clerk instance, and the host is legible in the name', () => {
	expect(PROD).not.toBe(DEV)
	expect(PROD).toContain('clerk.mykodama.app')
	// Stable across runs — it IS the lookup key for a grant that must survive restarts.
	expect(custodyAccount('https://clerk.mykodama.app')).toBe(PROD)
})

test('a dev daemon cannot delete the production grant it is not entitled to read', async () => {
	// Both run under the same macOS account. Sharing one item meant a dev refresh of a PRODUCTION
	// token was answered `invalid_grant` — correctly, it is not that instance's token — and the
	// clear path then deleted it, signing the shipped app out. Opening Settings in dev did it.
	const production = identityOver(keychainStore(PROD, SERVICE))
	await production.signIn()

	const held = () =>
		Bun.spawnSync(['security', 'find-generic-password', '-s', SERVICE, '-a', PROD, '-w'])
			.stdout.toString()
			.trim()
	expect(held()).toBe('rt-1')

	// The dev daemon comes up against the same Keychain and is told its (absent) grant is invalid.
	server.serve(() => Response.json({ error: 'invalid_grant' }, { status: 400 }))
	const dev = identityOver(keychainStore(DEV, SERVICE))
	expect(await dev.getToken()).toBeNull()
	expect(await dev.currentUser()).toBeNull()

	// Production is untouched: still in custody, and still serving its token.
	expect(held()).toBe('rt-1')
	expect(await production.getToken()).toBeTruthy()
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
