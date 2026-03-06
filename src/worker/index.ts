import { Hono } from 'hono'
import { createApi } from '../core/api'
import { getStore } from '../core/store'
import { fromD1 } from '../db'

const app = new Hono<{ Bindings: Env }>()

app.mount('/api', (req, env, executionCtx) => {
	const db = fromD1(env.db)
	const store = getStore(db)
	const be = createApi(store)
	return be.fetch(req, env, executionCtx)
})

export default app
