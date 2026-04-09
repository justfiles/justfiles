import { createFsApi } from '@ghostore/core'
import { Hono } from 'hono'
import type { Storage } from '@justfiles/fs/storage'

export function createWorkerApiApp(args: { fs: Storage }) {
	const { fs } = args

	return new Hono().route('/fs', createFsApi(fs))
}

export type WorkerApiType = ReturnType<typeof createWorkerApiApp>
