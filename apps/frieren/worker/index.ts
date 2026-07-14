import { verifyToken } from '@clerk/backend'
import { clerkMiddleware, getAuth } from '@clerk/hono'
import { type Context, Hono } from 'hono'
import { runIndexer, serveCommunityCatalog } from './appstore/feed.ts'

export { Frieren } from './frieren.ts'

type WorkerEnv = { Bindings: Env }
type Ctx = Context<WorkerEnv>

const requireClerkSecret = (env: Env): string => {
	if (!env.CLERK_SECRET_KEY) throw new Error('Missing CLERK_SECRET_KEY')
	return env.CLERK_SECRET_KEY
}

const forwardToFrieren = (c: Ctx, userId: string) =>
	c.env.FRIEREN.get(c.env.FRIEREN.idFromName(userId)).fetch(c.req.raw)

const app = new Hono<WorkerEnv>()

// Browsers can't set Authorization on a WS handshake, and Clerk cookie auth
// needs a handshake redirect a WS upgrade can't follow — so WS auth rides a
// `?token=` query param verified here, before clerkMiddleware. Forwarding
// `c.req.raw` preserves the path so the DO routes agent (`/ws`) vs. the shared
// capability-proxy socket (`/api/apps/_caps/ws`).
const tokenWs = async (c: Ctx) => {
	const token = new URL(c.req.url).searchParams.get('token')
	if (!token) return new Response('Unauthorized', { status: 401 })
	try {
		const { sub } = await verifyToken(token, { secretKey: requireClerkSecret(c.env) })
		if (!sub) return new Response('Unauthorized', { status: 401 })
		return forwardToFrieren(c, sub)
	} catch {
		return new Response('Unauthorized', { status: 401 })
	}
}
app.get('/ws', tokenWs)
// The one browser-opened socket per session: the shared capability-proxy (`_caps`).
app.get('/api/apps/_caps/ws', tokenWs)

// The community app-store catalog is public (no auth) and R2-backed, served by the
// worker rather than the static ASSETS (which carry only the built-in catalog).
app.get('/appstore/community.json', (c) => serveCommunityCatalog(c.env))

app.use('/fs/*', clerkMiddleware())
app.use('/api/*', clerkMiddleware())
app.all('/fs/*', (c) => {
	const userId = getAuth(c)?.userId
	if (!userId) return new Response('Unauthorized', { status: 401 })
	return forwardToFrieren(c, userId)
})
app.all('/api/*', (c) => {
	const userId = getAuth(c)?.userId
	if (!userId) return new Response('Unauthorized', { status: 401 })
	return forwardToFrieren(c, userId)
})

// The worker is both a request handler and the app-store indexer: `scheduled`
// runs on the cron trigger (wrangler.jsonc), rebuilding the community catalog in
// R2 from the `spud-app` npm keyword. `waitUntil` keeps it alive past the tick.
export default {
	fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
	scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
		ctx.waitUntil(runIndexer(env))
	}
}
