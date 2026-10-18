import { createClerkClient } from '@clerk/backend'
import { clerkMiddleware, getAuth } from '@clerk/hono'
import { ResetBody } from '@justfiles/core'
import { type Context, Hono } from 'hono'
import { bearerFromProtocolHeader } from '../shared/caps-ws.ts'
import { ACCEPTED_TOKENS, actingUserId, forwardRequest } from './auth.ts'
import { Frieren } from './frieren.ts'
import { type AcknowledgedResetResult, acknowledgeReset } from './reset-ack.ts'

export { Frieren }

type WorkerEnv = { Bindings: Env }
type Ctx = Context<WorkerEnv>

const requireClerkSecret = (env: Env): string => {
	if (!env.CLERK_SECRET_KEY) throw new Error('Missing CLERK_SECRET_KEY')
	return env.CLERK_SECRET_KEY
}

const forwardToFrieren = (c: Ctx, userId: string) =>
	c.env.FRIEREN.get(c.env.FRIEREN.idFromName(userId)).fetch(forwardRequest(c.req.raw, userId))

const ownerStub = (c: Ctx, userId: string) => c.env.FRIEREN.get(c.env.FRIEREN.idFromName(userId))

const resetResponse = (c: Ctx, result: AcknowledgedResetResult) => {
	if (result.ok) return c.json({ generation: result.generation })
	// Retryable, not a refusal: the reset may well have committed, and the client's durable
	// operationId makes asking again idempotent. A stale CAS is the definitive 409.
	if (result.error === 'reset_unconfirmed')
		return c.json({ error: result.error, generation: result.generation }, 503)
	return c.json({ error: result.error, generation: result.generation }, 409)
}

const app = new Hono<WorkerEnv>()

// Browsers can't set Authorization on a WS handshake, and Clerk cookie auth
// needs a handshake redirect a WS upgrade can't follow — so WS auth rides the
// handshake. The capability socket (`_caps`) sends the token as a
// `bearer.<token>` WebSocket subprotocol, keeping it out of the URL where query
// strings leak into proxy/access logs and browser history; the agent socket
// (`/ws`) still uses `?token=`. Read whichever is present, before
// clerkMiddleware. Forwarding `c.req.raw` preserves the path so the DO routes
// agent (`/ws`) vs. the shared capability-proxy socket (`/api/apps/_caps/ws`).
const wsToken = (req: Request): string | null =>
	bearerFromProtocolHeader(req.headers.get('Sec-WebSocket-Protocol')) ??
	new URL(req.url).searchParams.get('token')
// Authenticated through `authenticateRequest` over a synthesised Authorization header rather
// than `verifyToken`, which accepts session tokens ONLY (it rejects the daemon's OAuth access
// token outright: `Invalid JWT type "at+jwt"`). One path, both credential kinds.
const tokenWs = async (c: Ctx) => {
	const token = wsToken(c.req.raw)
	if (!token) return new Response('Unauthorized', { status: 401 })
	try {
		const clerk = createClerkClient({
			secretKey: requireClerkSecret(c.env),
			publishableKey: c.env.CLERK_PUBLISHABLE_KEY
		})
		const state = await clerk.authenticateRequest(
			new Request(c.req.url, { headers: { authorization: `Bearer ${token}` } }),
			{ acceptsToken: ACCEPTED_TOKENS }
		)
		const userId = actingUserId(state.toAuth())
		if (!userId) return new Response('Unauthorized', { status: 401 })
		return forwardToFrieren(c, userId)
	} catch {
		return new Response('Unauthorized', { status: 401 })
	}
}
app.get('/ws', tokenWs)
// The one browser-opened socket per session: the shared capability-proxy (`_caps`).
app.get('/api/apps/_caps/ws', tokenWs)

app.post('/fs/reset', clerkMiddleware(), async (c) => {
	const userId = actingUserId(getAuth(c, { acceptsToken: ACCEPTED_TOKENS }))
	if (!userId) return new Response('Unauthorized', { status: 401 })
	const parsed = ResetBody.safeParse(await c.req.json().catch(() => undefined))
	if (!parsed.success) return c.json({ error: 'invalid reset request' }, 400)
	const result =
		parsed.data.mode === 'complete'
			? await ownerStub(c, userId).completeReset(parsed.data.resetId)
			: // A factory, not one handle: the restart kills the RPC session it went out on, so
				// confirming has to reconnect (see reset-ack.ts).
				await acknowledgeReset(() => ownerStub(c, userId), parsed.data)
	return resetResponse(c, result)
})

// `/store` is the store model's wire, `/fs` is the old one, and both reach the same
// owner the same way. Auth is the host's, in front of the mount: `storeApi` decides no
// policy of its own.
app.use('/store/*', clerkMiddleware())
app.use('/fs/*', clerkMiddleware())
app.use('/api/*', clerkMiddleware())
// `clerkMiddleware` already authenticates with `acceptsToken: 'any'`; naming the two kinds we
// accept here is what lets the daemon's OAuth token through (a session token stays the
// browser's path) while everything else — an API key, an M2M token — is still refused.
const routeToOwner = (c: Ctx) => {
	const userId = actingUserId(getAuth(c, { acceptsToken: ACCEPTED_TOKENS }))
	if (!userId) {
		const path = c.req.path
		if (path === '/api/v1/apps' || path.startsWith('/api/v1/apps/'))
			return c.json({ error: { code: 'unauthorized', message: 'authentication is required' } }, 401)
		return new Response('Unauthorized', { status: 401 })
	}
	return forwardToFrieren(c, userId)
}
app.all('/store/*', routeToOwner)
app.all('/fs/*', routeToOwner)
app.all('/api/*', routeToOwner)

export default {
	fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx)
}
