import { useAuth } from '@clerk/clerk-react'
import { hc } from 'hono/client'
import { useMemo } from 'react'
import type { WorkerApiType } from '../worker/app'

export type FsClient = ReturnType<typeof hc<WorkerApiType>>['fs']

function makeHeaders(getToken: () => Promise<string | null>) {
	return async () => {
		const token = await getToken()
		return { Authorization: `Bearer ${token ?? ''}` }
	}
}

export function createFsClient(getToken: () => Promise<string | null>): FsClient {
	return hc<WorkerApiType>('', { headers: makeHeaders(getToken) }).fs
}

export function useFsClient() {
	const { getToken } = useAuth()
	return useMemo(() => createFsClient(getToken), [getToken])
}
