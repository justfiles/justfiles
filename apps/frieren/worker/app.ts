import { createFsApi } from '@justfiles/core'
import type { Storage } from '@justfiles/fs/storage'
import { Hono } from 'hono'

export function createFrierenApiApp(fs: Storage) {
	return new Hono().get('/', (c) => c.json({ name: 'Frieren' })).route('/fs', createFsApi(fs))
}
