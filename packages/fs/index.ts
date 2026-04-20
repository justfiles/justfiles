export {
	FsCursorExpiredError,
	type FsOp,
	type InodeMeta,
	isFsCursorExpiredError,
	type MutationOptions,
	type ScanEntry,
	type Storage,
	type StorageCapabilities,
	type UpdateQueryOptions
} from './storage'
export { synced } from './synced'
export { type Volume, volume } from './volume'
export { decodeXattr, encodeXattr, GHOSTORE_XATTR, XATTR_NAMESPACE } from './xattr'
