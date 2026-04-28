import { verifyToken } from '@clerk/backend'
import { clerkMiddleware, getAuth } from '@clerk/hono'
import { type Context, Hono } from 'hono'
import { BRIDGE_JS, getAsset, getEntryPath, hasApp } from './frieren.app'

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
// Bundled HTML carries `crossorigin` on its module/CSS tags, and the iframe
// is sandboxed (origin: null), so the browser CORS-checks every asset. Allow
// any origin since these are already public.
//
// TODO(security): production hardening for cross-origin asset access.
// `*` is acceptable today because:
//   - assets are public (no auth, no cookies — Allow-Credentials stays false,
//     and `*` cannot be combined with credentialed CORS anyway)
//   - bundle contents are static UI; nothing user-specific is baked in
// Risks if those invariants ever slip:
//   - any third-party site can fetch and read app bundles (hot-linking; data
//     leakage if a build accidentally inlines secrets or per-tenant config)
//   - the wildcard hides the actual caller, so we can't audit who's loading
//     bundles from off-domain
// Recommended hardening, in order of priority:
//   1. Move app assets to a dedicated origin (apps.<DOMAIN>) — the existing
//      FUTURE note below. Isolates the sandbox iframe from host-origin paths
//      AND lets us treat the apps origin as a static-only CDN with its own
//      caching/abuse story.
//   2. Add a build-time check that app bundles contain no secrets / env-
//      specific URLs / per-tenant data. (Audit script over dist before
//      registering in the host.)
//   3. Once the apps origin is split out, narrow `*` → an explicit list:
//      the host origin and `null` (for sandbox iframes), reflected from the
//      Origin header. Keeps random sites from hot-linking.
//   4. Consider SRI hashes on the script/link tags if hot-linking becomes a
//      real abuse vector — Vite emits stable hashed names, so this is cheap.
const appAssetHeaders = (path: string): Record<string, string> => ({
	'content-type': mimeFor(path),
	'access-control-allow-origin': '*'
})
app.get(
	'/apps/_bridge.js',
	() => new Response(BRIDGE_JS, { headers: appAssetHeaders('_bridge.js') })
)
app.get('/apps/*', (c) => {
	const rest = c.req.path.replace(/^\/apps\//, '').split('/')
	const appId = rest.shift()!
	if (!hasApp(appId)) return c.notFound()
	const path = rest.join('/') || getEntryPath(appId) || 'index.html'
	const content = getAsset(appId, path)
	if (content === undefined) return c.notFound()
	const body = path.endsWith('.html') ? injectBridge(content) : content
	return new Response(body, { headers: appAssetHeaders(path) })
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
