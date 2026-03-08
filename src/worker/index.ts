import { clerkMiddleware, getAuth } from '@hono/clerk-auth'
import { Hono } from 'hono'
import { MemoryObject } from './memory-object'

type WorkerBindings = { Bindings: Env }

const app = new Hono<WorkerBindings>()

app.use('/api/*', clerkMiddleware())
app.use('/api/*', async (c) => {
	const auth = getAuth(c)
	const userId = auth?.userId
	if (!userId) {
		return new Response('Unauthorized', { status: 401 })
	}

	const id = c.env.STORE.idFromName(userId)
	const stub = c.env.STORE.get(id)
	return stub.fetch(c.req.raw)
})

export { MemoryObject }
export default app
