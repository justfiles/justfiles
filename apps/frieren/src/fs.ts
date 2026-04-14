import { apiStorage, createFsClient as createCoreFsClient, type FsClient } from '@justfiles/core'
import { volume, type Volume } from '@justfiles/fs'

export type { FsClient, Volume }

export type GetToken = () => Promise<string | null>

function makeHeaders(getToken: GetToken) {
	return async () => {
		const token = await getToken()
		return { Authorization: `Bearer ${token ?? ''}` }
	}
}

export function createFsClient(getToken: GetToken): FsClient {
	return createCoreFsClient({ baseUrl: '/fs', headers: makeHeaders(getToken) })
}

export async function createFsVolume(getToken: GetToken): Promise<Volume> {
	return volume(await apiStorage(createFsClient(getToken)))
}
