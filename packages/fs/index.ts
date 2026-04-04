export {fs, type FileSystem} from './fs'
export {
	FsCursorExpiredError,
	isFsCursorExpiredError,
	type StorageBackend,
	type FsOp,
	type MutationOptions,
	type UpdateQueryOptions
} from './storage'
export {GHOSTORE_XATTR, XATTR_NAMESPACE, decodeXattr, encodeXattr} from './xattr'
export {idbStorage, type IdbStorageBackend} from './storage.idb'
export {cachedStorage, type CachedStorageBackend} from './storage.cached'
export {volume, type Volume} from './volume'
export {synced} from './synced'
