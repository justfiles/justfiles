import { Hono } from 'hono'
import { createFrierenApiApp } from './app.ts'

export { Frieren } from './frieren.ts'

type WorkerEnv = {
	Bindings: Env
}

const app = new Hono<WorkerEnv>()

app.get('/ws', (c) => {
	const id = c.env.FRIEREN.idFromName('default')
	const stub = c.env.FRIEREN.get(id)
	return stub.fetch(c.req.raw)
})

for (const path of ['/fs', '/fs/*'] as const) {
	app.all(path, (c) => {
		const id = c.env.FRIEREN.idFromName('default')
		const stub = c.env.FRIEREN.get(id)
		return stub.fetch(c.req.raw)
	})
}

app.route('/api', createFrierenApiApp())

export default app
