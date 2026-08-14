// Who a request may act as. Two credential kinds reach this worker and both resolve to the
// same Clerk user id — which is all the DO routing needs (`idFromName(userId)`):
//
//   session_token  a browser tab signed in with Clerk
//   oauth_token    the Mac daemon, an OAuth public client of our Clerk instance (#304)
//
// Pinning the client id is the load-bearing part. `@clerk/backend` verifies that a token was
// minted by THIS instance, not by WHICH OAuth application — so without this check, any other
// OAuth app on the instance (including one created by dynamic client registration) would be a
// full-access key to `/fs/*` for every user who consented to it.

// Structural, so this stays testable with plain objects: every Clerk auth object (signed in,
// signed out, machine, invalid-token) fits it.
export interface RequestAuth {
	tokenType: string | null
	isAuthenticated: boolean
	userId?: string | null
	clientId?: string | null
}

export const ACCEPTED_TOKENS: ['session_token', 'oauth_token'] = ['session_token', 'oauth_token']

const USER_ID_HEADER = 'x-user-id'

export function forwardRequest(request: Request, userId: string): Request {
	const headers = new Headers(request.headers)
	headers.set(USER_ID_HEADER, userId)
	return new Request(request, { headers })
}

export function requestUserId(request: Request): string | undefined {
	return request.headers.get(USER_ID_HEADER) ?? undefined
}

// Our own desktop OAuth applications, one per Clerk instance (production, then development /
// staging). Public identifiers, like the publishable key — kept in source rather than in
// `vars` because wrangler's `vars` win over `.dev.vars`, so a per-environment var would make
// local development the one place this is wrong. Listing both instances is safe: a token only
// reaches this check after it verified against ITS instance's key, so the dev app's id can
// never let a dev token through in production. What it does exclude is the thing that matters
// — some other OAuth application on the same instance.
const DESKTOP_CLIENT_IDS: readonly string[] = ['XRdrHVsy0Fa1P8qq', 'DQfbAd3ksCt3Rjs1']

export function actingUserId(
	auth: RequestAuth | null | undefined,
	clients: readonly string[] = DESKTOP_CLIENT_IDS
): string | null {
	if (!auth?.isAuthenticated) return null
	// `acceptsToken` already narrows the kinds that reach us; re-stating it here keeps this
	// function true on its own, because the failure mode of getting it wrong is silent access.
	if (auth.tokenType === 'oauth_token') {
		return auth.clientId && clients.includes(auth.clientId) ? (auth.userId ?? null) : null
	}
	return auth.tokenType === 'session_token' ? (auth.userId ?? null) : null
}
