// The daemon's Kodama identity. The Mac is an OAuth 2.0 **public client** of our own Clerk
// instance (the "installed app" shape, RFC 8252): sign-in opens the default browser on
// Clerk's own `/oauth/authorize`, catches the redirect on 127.0.0.1, and exchanges the code
// with PKCE and no client secret. There is no Kodama-side sign-in page, no pairing route and
// no server-held device record — the whole flow is Clerk's, and the worker just accepts a
// second kind of token (`acceptsToken: ['session_token', 'oauth_token']`).
//
// NOT a Clerk "session": Clerk's long-lived client JWT is only reachable through the Native
// API, which is gated to the Expo/iOS/Android SDKs and validated against a bundle id. What a
// desktop client can hold is an OAuth refresh token, and that is what this module holds.
//
// Custody split, and why:
//   refresh token  opaque, no expiry, ROTATES on every use  → macOS Keychain
//   access token   JWT, `sub` = Clerk user id, 24h           → memory only
// The access token stays out of the Keychain (and off the Volume) because it survives
// revocation until it expires; the refresh token stays out of memory-only custody because
// losing it costs the user a re-sign-in.
//
// The single-flight lock below is not an optimisation. Clerk does refresh-token reuse
// detection: replaying a rotated token returns `400 invalid_grant` AND kills the whole grant
// (measured). So exactly one refresh may be in flight, and the rotated token is persisted
// BEFORE the new access token is handed out — a hand-out we can't record is a hand-out that
// dies on the next refresh.
//
// ONE SEAM, THREE RULES. Every bug found in review lived in the same place: between what the
// network (or the Keychain) just told us and what this module believes about the user. If you
// are changing anything below, these are the invariants that keep it honest.
//
//   1. Only a POSITIVE answer settles state. "Signed out" is a fact only when Clerk says
//      `invalid_grant` or the store says the item is not there. A request that failed, a
//      keychain that would not open — those are "we cannot tell", and must leave the previous
//      belief (including "unresolved") intact so the next attempt retries.
//   2. Local state changes go FIRST and synchronously. `signOut` drops the cached token and
//      publishes before it awaits anything, because every await after that can fail, and none
//      of those failures may leave `getToken()` still answering for a user who signed out. It
//      is also STICKY: once asked to forget, this process never re-authenticates from custody
//      it failed to delete — only a sign-in that actually reaches a new grant re-arms it.
//      Corollary: ANSWER FROM `state`, never from a local captured before an await. A userinfo
//      round trip is long enough for a sign-out to happen inside it.
//   3. `generation` fences, and the QUEUE makes the fence mean something. Sign-in and sign-out
//      bump it; refresh, sign-in and the profile fetch capture it on entry. But a check before
//      an `await` says nothing about the state after it — so every mutation of custody runs
//      inside `serial()`, one at a time, and every change of belief goes through `commit()`,
//      which is synchronous and re-checks the fence in the same tick as the assignment. Nothing
//      that waits on the network or the browser may hold the queue: it covers Keychain calls
//      only, never a `fetch`.
//
// WHAT THIS CANNOT DO: all of the above is per-process. Two daemons can currently run at once
// (`Daemon.ensure()` in Launcher.swift has no single-writer lock — see #342), and two processes
// refreshing the same stored token trip Clerk's reuse detection and destroy the grant. No
// amount of in-process care fixes that; the fix is one daemon per user. Until then the failure
// is at least loud and recoverable: `invalid_grant` clears custody and the UI says sign in
// again.

import type { AuthFlow } from '@justfiles/app/capabilities/accounts/providers'
import type { UserProfile } from '@justfiles/app/capabilities/settings'
import { loopbackAuthFlow } from './google/oauth'
import { keychainStore, type SecretStore } from './keychain'
import { SHIPPED } from './resources'

// The path the loopback listener answers on. Clerk matches a registered redirect URI's host
// and path exactly but IGNORES the port for loopback (RFC 8252 §7.3, measured) — which is
// what lets `loopbackAuthFlow()` keep binding an OS-assigned port while the OAuth app has a
// single registered URI.
const CALLBACK_PATH = '/auth/callback'
const SCOPES = 'profile email offline_access'
// Refresh this far before `exp`. Tokens live 24h, so this is deliberately generous: the cost
// of an early refresh is one request, the cost of a late one is a failed capability call.
const REFRESH_SKEW_MS = 5 * 60_000
// Sign-out clears local custody first and only then tells Clerk, so this bounds the wait on a
// server that stalls rather than refusing — not how long the user stays signed in (they are
// already signed out by the time it runs).
const REVOKE_TIMEOUT_MS = 5_000

export interface Identity {
	// A bearer token for our own API, or null when signed out / unreachable. Never throws:
	// every caller branches on null (that is how "signed out" and "offline" stay ordinary).
	getToken(): Promise<string | null>
	signIn(opts?: { signal?: AbortSignal }): Promise<UserProfile>
	signOut(): Promise<void>
	currentUser(): Promise<UserProfile | null>
	// Fires on sign-in and sign-out, so E2's router can flip between local-only and proxying
	// without a restart. Returns an unsubscribe.
	onChange(listener: (user: UserProfile | null) => void): () => void
}

export interface IdentityDeps {
	// Clerk Frontend API origin — the OAuth authorization server (see its
	// /.well-known/oauth-authorization-server).
	fapi: string
	clientId: string
	flow: AuthFlow
	store: SecretStore
}

interface TokenResponse {
	access_token: string
	refresh_token: string
	expires_in: number
}

const b64url = (bytes: Uint8Array): string =>
	Buffer.from(bytes).toString('base64url').replace(/=+$/, '')
const randomB64url = (n: number): string => b64url(crypto.getRandomValues(new Uint8Array(n)))

async function challengeFor(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
	return b64url(new Uint8Array(digest))
}

// Our own token, straight off the wire from Clerk over TLS — read, never verified. The
// worker is the party that verifies it.
function subjectOf(accessToken: string): string {
	const payload = accessToken.split('.')[1]
	if (!payload) throw new Error('sign-in returned a token we cannot read')
	const { sub } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub?: string }
	if (!sub) throw new Error('sign-in returned a token with no subject')
	return sub
}

export function createIdentity(deps: IdentityDeps): Identity {
	const { fapi, clientId, flow, store } = deps

	// EVERYTHING this module believes, in one value. Not four variables: the bugs this module was
	// reviewed for were all half-applied states — a token adopted after a sign-out had cleared it,
	// a user published over a sign-out's `null`. A snapshot cannot be half-applied.
	type State = {
		// `undefined` = not resolved yet; `null` = signed out. The distinction is what lets
		// `currentUser()` answer from cache without a network hop once it is known, while an offline
		// boot stays unresolved and retries.
		readonly user: UserProfile | null | undefined
		readonly token: { value: string; expires: number } | undefined
		// Set by sign-out, cleared by sign-in. Custody is the source of truth for "signed in" — until
		// the user says otherwise: deleting the Keychain item can fail (a locked keychain), and
		// re-minting tokens from a credential we were asked to forget is the one thing sign-out must
		// never do. Worst case that leaves a dead item on disk, which the next sign-out clears.
		readonly forgotten: boolean
	}
	let state: State = { user: undefined, token: undefined, forgotten: false }
	let inFlight: Promise<string | null> | undefined
	// Bumped by every explicit sign-in/sign-out. Anything already in flight when it moves must not
	// land — otherwise a refresh (or a profile fetch) that started before a sign-out arrives after
	// it and silently signs the daemon back in.
	let generation = 0
	const listeners = new Set<(user: UserProfile | null) => void>()

	// THE ONLY WAY STATE CHANGES. Synchronous, so nothing can interleave inside it, and fenced, so
	// an operation whose grant has been superseded cannot land — which is what makes "check the
	// fence, then act" safe: there is no `await` between the two. `at` is the generation the caller
	// began in; `null` means "this IS the newest action" (sign-in and sign-out, which bump it).
	// Returns false when the commit was refused, which callers report rather than paper over.
	function commit(at: number | null, next: State): boolean {
		if (at !== null && at !== generation) return false
		const before = state.user
		state = next
		// Identity changes only — a plain 24h refresh must not wake E2's router. Callers pass the
		// SAME user object when nothing about the person changed, so this stays a reference compare.
		if (before !== next.user) for (const listener of listeners) listener(next.user ?? null)
		return true
	}

	const form = (body: Record<string, string>, path: string, signal?: AbortSignal) =>
		fetch(new URL(path, fapi), {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(body),
			signal
		})

	// Every read/write/delete of custody goes through here, one at a time — see rule 3. A
	// rejection is contained so it cannot poison the queue for the next caller.
	let queue: Promise<unknown> = Promise.resolve()
	function serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = queue.then(fn, fn)
		queue = run.then(
			() => undefined,
			() => undefined
		)
		return run
	}

	// Persist the rotation, then adopt the token. Order matters (see the header): a token whose
	// subject we cannot read is not a sign-in, and a rotation we cannot record is not one either.
	// If the commit is refused, the rotation stays in the Keychain on purpose — whoever superseded
	// us is queued behind this section and owns custody now (a sign-out will delete and revoke it).
	function adopt(res: TokenResponse, at: number): Promise<UserProfile | null> {
		const id = subjectOf(res.access_token)
		return serial(async () => {
			if (at !== generation) return null
			await store.write(res.refresh_token)
			const user = state.user?.id === id ? state.user : { id }
			const token = { value: res.access_token, expires: Date.now() + res.expires_in * 1000 }
			return commit(at, { user, token, forgotten: false }) ? { id } : null
		})
	}

	async function refresh(): Promise<string | null> {
		if (state.forgotten) return null
		const at = generation
		// A read that FAILS (locked or denied Keychain) is not an absent grant, but for a refresh
		// both mean the same thing: answer null and change nothing.
		const stored = await serial(() => store.read().catch(() => undefined))
		if (!stored) return null
		let res: Response
		try {
			res = await form(
				{ grant_type: 'refresh_token', refresh_token: stored, client_id: clientId },
				'/oauth/token'
			)
		} catch {
			// Offline. Keep the credential: a network we cannot reach is not a revoked grant.
			return null
		}
		if (!res.ok) {
			// `invalid_grant` is the one unrecoverable answer (revoked, or a rotation we lost);
			// everything else — 5xx, a rate limit, a proxy's HTML — leaves the grant alone.
			const error = await res
				.json()
				.then((body) => (body as { error?: string }).error)
				.catch(() => undefined)
			if (error === 'invalid_grant') {
				// In the queue and fenced: an older grant's "revoked" must not delete the grant that
				// replaced it, nor publish signed-out over its user.
				await serial(async () => {
					if (!commit(at, { user: null, token: undefined, forgotten: state.forgotten })) return
					await store.remove().catch(() => {})
				})
			}
			return null
		}
		try {
			return (await adopt((await res.json()) as TokenResponse, at))
				? (state.token?.value ?? null)
				: null
		} catch {
			// The rotation could not be recorded (or the token could not be read), so the token we
			// were just handed is the last one this grant will ever mint. Refusing to use it keeps
			// "signed in" honest.
			commit(at, { user: state.user, token: undefined, forgotten: state.forgotten })
			return null
		}
	}

	async function getToken(): Promise<string | null> {
		const held = state.token
		if (held && held.expires - Date.now() > REFRESH_SKEW_MS) return held.value
		inFlight ??= refresh().finally(() => {
			inFlight = undefined
		})
		return inFlight
	}

	async function signIn(opts?: { signal?: AbortSignal }): Promise<UserProfile> {
		// Advance, don't just capture: a refresh or profile fetch belonging to the OLD grant must not
		// be allowed to finish into this one — it would overwrite the new Keychain item with the old
		// grant's rotation, or (on `invalid_grant`) delete the grant we are about to store.
		const at = ++generation
		// NOT re-armed here: after a sign-out whose Keychain delete failed, `forgotten` is the only
		// thing keeping the leftover grant unusable, and a sign-in the user cancels (or that fails to
		// exchange) must not hand it back. `adopt` commits `forgotten: false` when a NEW grant is
		// actually in custody — the only moment re-arming is earned.
		const verifier = randomB64url(32)
		const challenge = await challengeFor(verifier)
		// The OAuth `state` parameter — named apart from this module's own `state` on purpose.
		const oauthState = randomB64url(16)
		let redirectUri = ''
		const callback = await flow.authorize((origin) => {
			redirectUri = `${origin}${CALLBACK_PATH}`
			const url = new URL('/oauth/authorize', fapi)
			url.search = new URLSearchParams({
				response_type: 'code',
				client_id: clientId,
				redirect_uri: redirectUri,
				scope: SCOPES,
				state: oauthState,
				code_challenge: challenge,
				code_challenge_method: 'S256'
			}).toString()
			return url.toString()
		}, opts)
		const code = callback.searchParams.get('code')
		if (!code || callback.searchParams.get('state') !== oauthState) {
			throw new Error('Kodama sign-in failed or was cancelled')
		}
		const res = await form(
			{
				grant_type: 'authorization_code',
				code,
				redirect_uri: redirectUri,
				client_id: clientId,
				code_verifier: verifier
			},
			'/oauth/token'
		)
		if (!res.ok) throw new Error(`Kodama sign-in failed (${res.status})`)
		const profile = await adopt((await res.json()) as TokenResponse, at)
		// A sign-out landed while the browser was open. The last explicit instruction wins.
		if (!profile) throw new Error('Kodama sign-in was superseded by a sign-out')
		return profile
	}

	async function signOut(): Promise<void> {
		// Rule 2 (see the header): the local half is ONE synchronous commit before any await, so no
		// failure below — a locked Keychain, a stalled Clerk — can leave `getToken()` answering for a
		// user who just signed out, and nothing already in flight can put it back (rule 3).
		const at = ++generation
		commit(null, { user: null, token: undefined, forgotten: true })
		// Custody in the queue, and fenced inside it: a sign-in that started after this sign-out must
		// not have its brand-new grant read, deleted, and then handed to Clerk to revoke. Deleting
		// can fail (a locked keychain) — hold the failure rather than throwing on the spot, because
		// revoking matters MORE: a revoked grant makes a leftover item worthless, while an un-revoked
		// one stays usable by whoever can read it.
		const { stored, undeleted } = await serial<{ stored?: string; undeleted?: Error }>(async () => {
			if (at !== generation) return {}
			const held = await store.read().catch(() => undefined)
			const failure = await store.remove().then(
				() => undefined,
				(error: unknown) => (error instanceof Error ? error : new Error(String(error)))
			)
			return { stored: held, undeleted: failure }
		})
		// Best effort, and bounded: a revoke we cannot deliver must not strand the caller. The grant
		// outlives us for up to a day if this fails — the JWT-access-token trade recorded in #304.
		// Outside the queue deliberately: a stalled Clerk must not block the next sign-in's custody.
		if (stored) {
			await form(
				{ token: stored, client_id: clientId },
				'/oauth/token/revoke',
				AbortSignal.timeout(REVOKE_TIMEOUT_MS)
			).catch(() => {})
		}
		// Signed out everywhere that matters, but the credential is still on disk: the caller has to
		// be able to say so, because the next daemon that CAN read the Keychain would find it.
		if (undeleted) {
			throw new Error(`Signed out, but the Keychain item remains: ${undeleted.message}`)
		}
	}

	// Fill in display name/avatar for Settings, best effort: the id alone is a real identity, so a
	// userinfo call that fails costs a nicer label and nothing else. Only when something asks who
	// is signed in, and only until it answers with something — so a failure is retried on the next
	// ask rather than sticking for the life of the daemon.
	//
	// Returns nothing on purpose. Callers answer from `state` AFTER this resolves, never from the
	// profile they started with: a sign-out during the fetch has to make the pending `host.user`
	// resolve signed-out, or Settings latches a user who is no longer there until it reloads.
	async function describe(profile: UserProfile): Promise<void> {
		const at = generation
		const value = await getToken()
		if (!value) return
		try {
			const res = await fetch(new URL('/oauth/userinfo', fapi), {
				headers: { authorization: `Bearer ${value}` }
			})
			if (!res.ok) return
			const info = (await res.json()) as { name?: string; email?: string; picture?: string }
			const named: UserProfile = {
				id: profile.id,
				name: info.name || info.email || undefined,
				avatarUrl: info.picture
			}
			// A refused commit means we were superseded (a sign-out, or a sign-in as someone else) —
			// `commit` is where that is decided, and dropping the answer is the whole handling.
			if (named.name || named.avatarUrl) {
				commit(at, { user: named, token: state.token, forgotten: state.forgotten })
			}
		} catch {
			// A nicer label is not worth an error to the caller.
		}
	}

	return {
		getToken,
		signIn,
		signOut,
		currentUser: async () => {
			const at = generation
			// A stored refresh token is the source of truth for "signed in", so resolving the user
			// means minting a token — which is also what tells us the grant is still alive.
			if (state.user === undefined) {
				await getToken()
				// Still unresolved: either there is no grant, or we could not tell (offline, or a
				// Keychain that is locked or denied). Only an item the store positively does not have is
				// a fact. Caching anything else would leave Settings saying "Local user" for the rest of
				// the run with a perfectly good grant in the Keychain, so it stays unresolved and the
				// next ask retries.
				if (
					state.user === undefined &&
					(await serial(() =>
						store.read().then(
							(held) => !held,
							() => false
						)
					))
				) {
					commit(at, { user: null, token: state.token, forgotten: state.forgotten })
				}
			}
			const known = state.user
			if (known && !known.name) await describe(known)
			// Answer from state, never from `known`: it may be minutes old by now (a userinfo round
			// trip), and a sign-out in that window must win.
			return state.user ?? null
		},
		onChange: (listener) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		}
	}
}

// The instance this build talks to. A public client's id is not a secret (that is the whole
// point of PKCE), so it lives in source rather than in an env var nobody sets; the env vars
// exist for pointing a dev daemon at a different instance.
const INSTANCE = SHIPPED
	? { fapi: 'https://clerk.mykodama.app', clientId: 'XRdrHVsy0Fa1P8qq' }
	: { fapi: 'https://capable-spider-79.clerk.accounts.dev', clientId: 'DQfbAd3ksCt3Rjs1' }

// The daemon's one identity (the Mac gets a single account — see #290's E1 scope).
export const identity: Identity = createIdentity({
	fapi: process.env.KODAMA_CLERK_FAPI ?? INSTANCE.fapi,
	clientId: process.env.KODAMA_CLERK_CLIENT_ID ?? INSTANCE.clientId,
	flow: loopbackAuthFlow(),
	store: keychainStore('kodama-oauth')
})
