import { createFsApi } from '@justfiles/core'
import { Hono } from 'hono'
import type { Storage } from '@justfiles/fs/storage'

type ApiEnv = {
	Bindings: Env
}

export function createFrierenApiApp(args: { fs?: Storage } = {}) {
	const app = new Hono<ApiEnv>()
		.get('/', (c) => c.json({ name: 'Frieren' }))

	if (args.fs) {
		app.route('/fs', createFsApi(args.fs))
	}

	return app.all('*', (c) => c.json({ name: 'Frieren' }))
}

export type FrierenApiType = ReturnType<typeof createFrierenApiApp>
