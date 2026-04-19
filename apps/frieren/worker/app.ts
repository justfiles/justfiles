import { createFsApi } from '@justfiles/core'
import { Hono } from 'hono'
import type { Storage } from '@justfiles/fs/storage'

export function createFrierenApiApp(fs: Storage) {
	return new Hono()
		.get('/', (c) => c.json({ name: 'Frieren' }))
		.route('/fs', createFsApi(fs))
}
