import { createFsApi } from '@justfiles/core'
import { Hono } from 'hono'
import type { Storage } from '@justfiles/fs/storage'

type ApiEnv = {
	Bindings: Env
}

export function createFrierenApiApp(args: {
	fs?: Storage
	onNuke?: () => Promise<void>
} = {}) {
	const app = new Hono<ApiEnv>()
		.get('/', (c) => c.json({ name: 'Frieren' }))

	if (args.fs) {
		app.route('/fs', createFsApi(args.fs))
	}

	if (args.onNuke) {
		const onNuke = args.onNuke
		app.post('/api/nuke', async (c) => {
			await onNuke()
			return c.body(null, 204)
		})
	}

	return app.all('*', (c) => c.json({ name: 'Frieren' }))
}

export type FrierenApiType = ReturnType<typeof createFrierenApiApp>
