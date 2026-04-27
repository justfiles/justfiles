import { verifyToken } from '@clerk/backend'
import { clerkMiddleware, getAuth } from '@clerk/hono'
import { type Context, Hono } from 'hono'
import { ASSET_ENTRY, BRIDGE_JS, getAsset, hasApp } from './frieren.app'

export { Frieren } from './frieren.ts'

type WorkerEnv = { Bindings: Env }
type Ctx = Context<WorkerEnv>

const requireClerkSecret = (env: Env): string => {
	if (!env.CLERK_SECRET_KEY) throw new Error('Missing CLERK_SECRET_KEY')
	return env.CLERK_SECRET_KEY
}

const forwardToFrieren = (c: Ctx, userId: string) =>
	c.env.FRIEREN.get(c.env.FRIEREN.idFromName(userId)).fetch(c.req.raw)

const MIME: Record<string, string> = {
	html: 'text/html; charset=utf-8',
	js: 'application/javascript; charset=utf-8',
	mjs: 'application/javascript; charset=utf-8',
	css: 'text/css; charset=utf-8',
	json: 'application/json; charset=utf-8',
	svg: 'image/svg+xml'
}
const mimeFor = (path: string): string => {
	const ext = path.split('.').pop()?.toLowerCase() ?? ''
	return MIME[ext] ?? 'application/octet-stream'
}

// Inject the postMessage bridge into served HTML so app code can use
// `window.app.{state,subscribe,dispatch}` without authoring boilerplate.
// FUTURE: move app assets to a separate origin (apps.<domain>) so the
// sandboxed iframe can't fetch host-origin paths.
const BRIDGE_TAG = '<script src="/apps/_bridge.js"></script>'
const injectBridge = (html: string): string =>
	/<head\b[^>]*>/i.test(html)
		? html.replace(/<head\b([^>]*)>/i, `<head$1>${BRIDGE_TAG}`)
		: `${BRIDGE_TAG}${html}`

const app = new Hono<WorkerEnv>()

// Public, unauthenticated app assets — registered before clerk middleware.
app.get(
	'/apps/_bridge.js',
	() => new Response(BRIDGE_JS, { headers: { 'content-type': mimeFor('_bridge.js') } })
)
app.get('/apps/*', (c) => {
	const rest = c.req.path.replace(/^\/apps\//, '').split('/')
	const appId = rest.shift()!
	if (!hasApp(appId)) return c.notFound()
	const path = rest.join('/') || ASSET_ENTRY
	const content = getAsset(appId, path)
	if (content === undefined) return c.notFound()
	const body = path.endsWith('.html') ? injectBridge(content) : content
	return new Response(body, { headers: { 'content-type': mimeFor(path) } })
})

app.get('/ws', async (c) => {
	const token = new URL(c.req.url).searchParams.get('token')
	if (!token) return new Response('Unauthorized', { status: 401 })
	try {
		const { sub } = await verifyToken(token, { secretKey: requireClerkSecret(c.env) })
		if (!sub) return new Response('Unauthorized', { status: 401 })
		return forwardToFrieren(c, sub)
	} catch {
		return new Response('Unauthorized', { status: 401 })
	}
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
