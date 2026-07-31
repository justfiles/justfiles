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
	let token: { value: string; expires: number } | undefined
	let inFlight: Promise<string | null> | undefined
	// `undefined` = not resolved yet; `null` = signed out. The distinction is what lets
	// `currentUser()` answer from cache without a network hop once it is known.
	let user: UserProfile | null | undefined
	// Bumped by every explicit sign-in/sign-out. Anything already in flight when it moves must
	// not write custody or publish a user — otherwise a refresh (or a profile fetch) that started
	// before a sign-out lands after it and silently signs the daemon back in.
	let generation = 0
	const listeners = new Set<(user: UserProfile | null) => void>()

	const publish = (next: UserProfile | null) => {
		user = next
		for (const listener of listeners) listener(next)
	}

	const form = (body: Record<string, string>, path: string, signal?: AbortSignal) =>
		fetch(new URL(path, fapi), {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(body),
			signal
		})

	// Persist the rotation, then adopt the token. Order matters (see the header). A token whose
	// subject we cannot read is not a sign-in, so that check comes before anything is stored.
	// `at` is the generation the caller started in: a sign-out since then wins, and a rotation
	// that already reached the Keychain is taken back out rather than left as a live grant.
	async function adopt(res: TokenResponse, at: number): Promise<UserProfile | null> {
		const id = subjectOf(res.access_token)
		if (at !== generation) return null
		await store.write(res.refresh_token)
		if (at !== generation) {
			await store.remove().catch(() => {})
			return null
		}
		token = { value: res.access_token, expires: Date.now() + res.expires_in * 1000 }
		// Only on a change: a plain refresh must not wake E2's router every 24h.
		if (user?.id !== id) publish({ id })
		return { id }
	}

	async function refresh(): Promise<string | null> {
		const at = generation
		// A read that FAILS (locked or denied Keychain) is not an absent grant, but for a refresh
		// both mean the same thing: answer null and change nothing.
		const stored = await store.read().catch(() => undefined)
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
			if (error === 'invalid_grant' && at === generation) {
				await store.remove().catch(() => {})
				token = undefined
				publish(null)
			}
			return null
		}
		try {
			return (await adopt((await res.json()) as TokenResponse, at)) ? (token?.value ?? null) : null
		} catch {
			// The rotation could not be recorded (or the token could not be read), so the token we
			// were just handed is the last one this grant will ever mint. Refusing to use it keeps
			// "signed in" honest.
			token = undefined
			return null
		}
	}

	async function getToken(): Promise<string | null> {
		if (token && token.expires - Date.now() > REFRESH_SKEW_MS) return token.value
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
		const verifier = randomB64url(32)
		const challenge = await challengeFor(verifier)
		const state = randomB64url(16)
		let redirectUri = ''
		const callback = await flow.authorize((origin) => {
			redirectUri = `${origin}${CALLBACK_PATH}`
			const url = new URL('/oauth/authorize', fapi)
			url.search = new URLSearchParams({
				response_type: 'code',
				client_id: clientId,
				redirect_uri: redirectUri,
				scope: SCOPES,
				state,
				code_challenge: challenge,
				code_challenge_method: 'S256'
			}).toString()
			return url.toString()
		}, opts)
		const code = callback.searchParams.get('code')
		if (!code || callback.searchParams.get('state') !== state) {
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
		// Local first, remote second. Everything below the read is what "signed out" means to this
		// daemon, and none of it may wait on a network call that can stall: a hung revoke used to
		// leave the item in the Keychain, `getToken()` still answering, and `/sign-out` never
		// replying. The fence (`generation`) comes first so nothing in flight can undo any of it.
		generation++
		const stored = await store.read().catch(() => undefined)
		await store.remove()
		token = undefined
		publish(null)
		// Best effort, and bounded: a revoke we cannot deliver must not strand the caller. The grant
		// outlives us for up to a day if this fails — the JWT-access-token trade recorded in #304.
		if (stored) {
			await form(
				{ token: stored, client_id: clientId },
				'/oauth/token/revoke',
				AbortSignal.timeout(REVOKE_TIMEOUT_MS)
			).catch(() => {})
		}
	}

	// Display name/avatar for Settings, best effort: the id alone is a real identity, so a
	// userinfo call that fails costs a nicer label and nothing else. Only when something asks who
	// is signed in, and only until it answers with something — so a failure is retried on the
	// next ask rather than sticking for the life of the daemon.
	async function describe(profile: UserProfile): Promise<UserProfile> {
		const at = generation
		const value = await getToken()
		if (!value) return profile
		try {
			const res = await fetch(new URL('/oauth/userinfo', fapi), {
				headers: { authorization: `Bearer ${value}` }
			})
			if (!res.ok) return profile
			const info = (await res.json()) as { name?: string; email?: string; picture?: string }
			const named: UserProfile = {
				id: profile.id,
				name: info.name || info.email || undefined,
				avatarUrl: info.picture
			}
			// Signed out while we were asking: a label must never resurrect the user.
			if (at !== generation) return profile
			if (named.name || named.avatarUrl) publish(named)
			return user ?? named
		} catch {
			return profile
		}
	}

	return {
		getToken,
		signIn,
		signOut,
		currentUser: async () => {
			// A stored refresh token is the source of truth for "signed in", so resolving the user
			// means minting a token — which is also what tells us the grant is still alive.
			if (user === undefined) {
				await getToken()
				// Still unresolved: either there is no grant, or we could not tell (offline, or a
				// Keychain that is locked or denied). Only an item the store positively does not have is
				// a fact. Caching anything else would leave Settings saying "Local user" for the rest of
				// the run with a perfectly good grant in the Keychain, so it stays unresolved and the
				// next ask retries.
				if (
					user === undefined &&
					(await store.read().then(
						(held) => !held,
						() => false
					))
				) {
					publish(null)
				}
			}
			return user && !user.name ? await describe(user) : (user ?? null)
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
