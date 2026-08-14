import type { ContentStore, Storage, StorageCapabilities } from '@justfiles/fs/storage'
import { type NodeReplica, nodeSyncReplica, type SyncCapability } from './node'
import { type FullScanReplica, fullScanReplica } from './scan'

export type StorageSyncReplica =
	| {
			strategy: 'incremental'
			content: 'addressed' | 'ordinary'
			replica: NodeReplica
	  }
	| {
			strategy: 'scan'
			content: 'addressed' | 'ordinary'
			replica: FullScanReplica
	  }

type SyncCapabilities = StorageCapabilities & {
	readonly sync?: SyncCapability
	readonly content?: ContentStore
}

/** Select exactly one complete storage strategy at replica construction. */
export function storageSyncReplica(storage: Storage): StorageSyncReplica {
	const caps = storage.caps as SyncCapabilities | undefined
	const content = caps?.content
	if (caps?.sync)
		return {
			strategy: 'incremental',
			content: content ? 'addressed' : 'ordinary',
			replica: nodeSyncReplica(caps.sync, content)
		}
	return {
		strategy: 'scan',
		content: content ? 'addressed' : 'ordinary',
		replica: fullScanReplica(storage, content)
	}
}
