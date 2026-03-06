import { Hono } from 'hono'
import { MemoryObject } from './memory-object'

const app = new Hono<{ Bindings: Env }>()

app.mount('/api', (req, env) => {
	// TODO: better auth
	const tenant = req.headers.get('X-Tenant') ?? 'default'
	const id = env.STORE.idFromName(tenant)
	const stub = env.STORE.get(id)
	return stub.fetch(req)
})

export { MemoryObject }
export default app
