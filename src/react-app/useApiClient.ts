import { useAuth } from '@clerk/clerk-react'
import { hc } from 'hono/client'
import { useMemo } from 'react'
import type { ApiType } from '../core/api'

export type ApiClient = ReturnType<typeof hc<ApiType>>

function createApiClient(getToken: () => Promise<string | null>): ApiClient {
	return hc<ApiType>('/api', {
		headers: async () => {
			const token = await getToken()
			return { Authorization: `Bearer ${token ?? ''}` }
		}
	})
}

export function useApiClient() {
	const { getToken } = useAuth()

	return useMemo(() => createApiClient(getToken), [getToken])
}
