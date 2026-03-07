import { Hono } from 'hono'
import { clerkMiddleware, getAuth } from '@hono/clerk-auth'
import { MemoryObject } from './memory-object'

type ClerkBindings = Env

const TENANT_HEADER = 'X-Tenant-Id'
const app = new Hono<{ Bindings: ClerkBindings }>()

app.use('/api/*', clerkMiddleware())

app.use('/api/*', async (c) => {
	const auth = getAuth(c)
	const userId = auth?.userId
	if (!userId) {
		return new Response('Unauthorized', { status: 401 })
	}

	const forwardedUrl = new URL(c.req.url)
	forwardedUrl.pathname = forwardedUrl.pathname.replace(/^\/api/, '')
	const req = new Request(forwardedUrl, {
		method: c.req.raw.method,
		headers: new Headers(c.req.raw.headers),
		body: c.req.raw.body
	})

	req.headers.set(TENANT_HEADER, userId)

	const id = c.env.STORE.idFromName(userId)
	const stub = c.env.STORE.get(id)
	return stub.fetch(req)
})

export { MemoryObject }
export default app
