import { useAuth } from '@clerk/clerk-react'
import { createFsClient as createCoreFsClient, type FsClient } from '@justfiles/core'
import { useMemo } from 'react'

function makeHeaders(getToken: () => Promise<string | null>) {
	return async () => {
		const token = await getToken()
		return { Authorization: `Bearer ${token ?? ''}` }
	}
}

export type { FsClient }

export function createFsClient(getToken: () => Promise<string | null>): FsClient {
	return createCoreFsClient({ baseUrl: '/fs', headers: makeHeaders(getToken) })
}

export function useFsClient() {
	const { getToken } = useAuth()
	return useMemo(() => createFsClient(getToken), [getToken])
}
