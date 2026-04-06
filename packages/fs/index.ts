export {
	FsCursorExpiredError,
	isFsCursorExpiredError,
	type StorageBackend,
	type StorageCapabilities,
	type InodeMeta,
	type FsOp,
	type MutationOptions,
	type UpdateQueryOptions,
	type ScanEntry,
} from './storage'
export {GHOSTORE_XATTR, XATTR_NAMESPACE, decodeXattr, encodeXattr} from './xattr'
export {idbStorage, type IdbStorageBackend} from './storage.idb'
export {volume, type Volume} from './volume'
export {synced} from './synced'
