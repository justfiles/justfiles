import { useAuth } from '@clerk/clerk-react'
import { hc } from 'hono/client'
import { useMemo } from 'react'
import type { WorkerApiType } from '../worker/app'

export type ApiClient = ReturnType<typeof hc<WorkerApiType>>['api']
export type FsClient = ReturnType<typeof hc<WorkerApiType>>['fs']

function makeHeaders(getToken: () => Promise<string | null>) {
	return async () => {
		const token = await getToken()
		return { Authorization: `Bearer ${token ?? ''}` }
	}
}

export function createApiClient(getToken: () => Promise<string | null>): ApiClient {
	return hc<WorkerApiType>('', { headers: makeHeaders(getToken) }).api
}

export function createFsClient(getToken: () => Promise<string | null>): FsClient {
	return hc<WorkerApiType>('', { headers: makeHeaders(getToken) }).fs
}

export function useApiClient() {
	const { getToken } = useAuth()
	return useMemo(() => createApiClient(getToken), [getToken])
}

export function useFsClient() {
	const { getToken } = useAuth()
	return useMemo(() => createFsClient(getToken), [getToken])
}
