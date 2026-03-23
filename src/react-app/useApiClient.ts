import { useAuth } from '@clerk/clerk-react'
import { hc } from 'hono/client'
import { useMemo } from 'react'
import type { ApiType } from '../core/api'

export function useApiClient() {
	const { getToken } = useAuth()

	return useMemo(
		() =>
			hc<ApiType>('/api', {
				headers: async () => {
					const token = await getToken()
					return { Authorization: `Bearer ${token ?? ''}` }
				},
			}),
		[getToken],
	)
}
