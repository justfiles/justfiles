// Two credential kinds reach this worker. Both resolve to the Clerk user ID that routes the
// request to its Durable Object:
//
//   session_token  a browser tab signed in with Clerk
//   oauth_token    the Mac daemon, an OAuth client of our Clerk instance (#304)
//
// `@clerk/backend` checks the Clerk instance, but not the OAuth client. The client list below
// stops another OAuth app on that instance from reaching `/fs/*`, `/store/*`, and `/api/*`.

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

// Clerk checks the issuer first, so a development token cannot pass production checks. Source
// constants also stop Wrangler vars from overriding local `.dev.vars` values.
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
