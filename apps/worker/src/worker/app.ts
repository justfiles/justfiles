import { createFsApi } from '@justfiles/core'
import type { Storage } from '@justfiles/fs/storage'
import { Hono } from 'hono'

export function createWorkerApiApp(args: { fs: Storage }) {
	const { fs } = args

	return new Hono().route('/fs', createFsApi(fs))
}

export type WorkerApiType = ReturnType<typeof createWorkerApiApp>
