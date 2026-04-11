import { Hono } from 'hono'

type ApiEnv = {
	Bindings: Env
}

export function createFrierenApiApp() {
	return new Hono<ApiEnv>()
		.get('/', (c) => c.json({ name: 'Frieren' }))
		.all('*', (c) => c.json({ name: 'Frieren' }))
}

export type FrierenApiType = ReturnType<typeof createFrierenApiApp>
