import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsClient } from './useApiClient'

const mocks = vi.hoisted(() => ({
	apiStorage: vi.fn(),
	createVolume: vi.fn(),
	idbStorage: vi.fn(),
	remoteSyncReplica: vi.fn(),
	synced: vi.fn()
}))

vi.mock('@justfiles/core', () => ({
	apiStorage: mocks.apiStorage,
	remoteSyncReplica: mocks.remoteSyncReplica
}))

vi.mock('@justfiles/fs', () => ({
	decodeXattr: vi.fn(),
	GHOSTORE_XATTR: {},
	synced: mocks.synced,
	volume: mocks.createVolume
}))

vi.mock('@justfiles/fs/storage/idb', () => ({ idbStorage: mocks.idbStorage }))

import { createVolumeRuntime } from './useVolume'

describe('createVolumeRuntime', () => {
	beforeEach(() => {
		vi.resetAllMocks()
		mocks.idbStorage.mockReturnValue({})
		mocks.apiStorage.mockResolvedValue({})
		mocks.synced.mockResolvedValue({})
		mocks.createVolume.mockReturnValue({})
	})

	it('uses the HTTP replica factory for sync and API storage for direct remote access', async () => {
		const fsClient = {} as FsClient
		const remoteStorage = { rootIno: 'remote' }
		const remoteReplica = { pathDeltas: vi.fn() }
		mocks.apiStorage.mockResolvedValue(remoteStorage)
		mocks.remoteSyncReplica.mockReturnValue(remoteReplica)

		await createVolumeRuntime(fsClient)

		const props = mocks.synced.mock.calls[0]?.[0] as {
			remote: (options: {
				clientId: string
				generation: () => number | undefined
				lineageId: () => string | undefined
			}) => unknown
		}
		const options = {
			clientId: 'client-1',
			generation: () => 2,
			lineageId: () => 'lineage-1'
		}

		expect(props.remote).toBeTypeOf('function')
		expect(props.remote(options)).toBe(remoteReplica)
		expect(mocks.remoteSyncReplica).toHaveBeenCalledWith(fsClient, options)
		expect(mocks.createVolume).toHaveBeenCalledWith(remoteStorage)
	})
})
