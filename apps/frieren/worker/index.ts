import { verifyToken } from '@clerk/backend'
import { clerkMiddleware, getAuth } from '@clerk/hono'
import { type Context, Hono } from 'hono'

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

export default app
