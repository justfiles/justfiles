import { verifyToken } from '@clerk/backend'
import { clerkMiddleware, getAuth } from '@clerk/hono'
import { type Context, Hono } from 'hono'
import { BUILTINS } from './builtins/index.ts'

export { Frieren } from './frieren.ts'

// Built-in icons ship with the worker bundle (same bytes for every user), so
// the launcher loads them via plain `<img src>` — no token, no DO round-trip.
// Version-stamped requests (`?v=<manifest version>`) get an immutable cache.
const ICON_MIME: Record<string, string> = {
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
	gif: 'image/gif',
	ico: 'image/x-icon'
}

function tryServeBuiltinIcon(
	appId: string,
	path: string,
	version: string | undefined
): Response | undefined {
	const ext = path.split('.').pop()?.toLowerCase()
	const mime = ext ? ICON_MIME[ext] : undefined
	if (!mime) return undefined
	const builtin = BUILTINS.find((b) => b.id === appId)
	const bytes = builtin?.files[path]
	if (!builtin || !bytes) return undefined
	const headers: Record<string, string> = { 'content-type': mime }
	if (version && version === builtin.version) {
		headers['cache-control'] = 'public, max-age=31536000, immutable'
	}
	return new Response(bytes, { headers })
}

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
// `c.req.raw` preserves the path so the DO routes agent (`/ws`) vs. an app
// socket (`/api/apps/:appId/ws`).
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
app.get('/api/apps/:appId/ws', tokenWs)
// App GUI assets are fetched by dynamic import/runtime code, which can't set an
// Authorization header, so the token rides the URL. Icon-extension paths
// short-circuit to public byte serving — they're shipped in BUILTINS and don't
// need user routing.
app.get('/api/apps/:appId/*', (c) => {
	const appId = c.req.param('appId')
	const path = c.req.path.split('/').slice(4).join('/')
	const icon = tryServeBuiltinIcon(appId, path, c.req.query('v'))
	return icon ?? tokenWs(c)
})

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
