import { useMemo } from 'react'
import {
	cachedStorage,
	fs as createFs,
	idbStorage,
	type Volume,
	volume as createVolume,
} from 'ghost-fs'
import { apiStorage } from './storage.api'
import { createMemoryIndex, type MemoryIndex } from './memoryIndex'
import { type ApiClient, useApiClient } from './useApiClient'

export interface VolumeService {
	readonly volume: Volume
	readonly index: MemoryIndex
}

let volumeSingleton: VolumeService | null = null

function createVolumeService(api: ApiClient): VolumeService {
	const local = idbStorage('ghostore-fs')
	const remote = apiStorage(api)
	const storage = cachedStorage(local, remote)
	const vfs = createFs(storage)

	return {
		volume: createVolume(vfs),
		index: createMemoryIndex(),
	}
}

export function useVolume(): VolumeService {
	const api = useApiClient()

	return useMemo(() => {
		if (!volumeSingleton) {
			volumeSingleton = createVolumeService(api)
		}
		return volumeSingleton
	}, [api])
}
