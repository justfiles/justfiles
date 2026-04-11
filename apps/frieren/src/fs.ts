import { apiStorage, createFsClient as createCoreFsClient, type FsClient } from '@justfiles/core'
import { volume, type Volume } from '@justfiles/fs'

export type { FsClient, Volume }

export function createFsClient(): FsClient {
	return createCoreFsClient({ baseUrl: '/fs' })
}

export async function createFsVolume(): Promise<Volume> {
	return volume(await apiStorage(createFsClient()))
}
