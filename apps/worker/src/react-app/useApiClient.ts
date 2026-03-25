import { useAuth } from '@clerk/clerk-react'
import { hc } from 'hono/client'
import { useMemo } from 'react'
import type { WorkerApiType } from '../worker/app'

export type ApiClient = ReturnType<typeof hc<WorkerApiType>>['api']

export function createApiClient(getToken: () => Promise<string | null>): ApiClient {
	return hc<WorkerApiType>('', {
		headers: async () => {
			const token = await getToken()
			return { Authorization: `Bearer ${token ?? ''}` }
		}
	}).api
}

export function useApiClient() {
	const { getToken } = useAuth()

	return useMemo(() => createApiClient(getToken), [getToken])
}
