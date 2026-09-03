export type { DbAdapter, SqlValue, SyncDb } from './db'
export { createDoAdapter, createDoSyncDb, type DoStorage } from './db.do'
export { createSqliteAdapter, createSqliteSyncDb } from './db.sqlite'
export { fileApi } from './file.api'
export {
	createFsApi,
	type DestructiveResetBody,
	ResetBody,
	type ResetResult
} from './fs'
export type { FsApiType, FsClient, FsClientOptions } from './fs.client'
export { createFsClient } from './fs.client'
export { migrateSqlite } from './migrate.sqlite'
export { migrateSync, parseSqlStatements, type SyncMigrator } from './migrations/utils'
export {
	clearReset,
	decideReset,
	type GenerationState,
	type ResetDecision,
	type ResetStatus,
	type ResetStores,
	readGenerationState,
	readResetStatus,
	resetStore
} from './reset'
// The server half of the seam, unexported until the first consumer arrived: half a
// server surface is no use to anyone.
export { storeApi, syncStoreApi } from './store.api'
export { type BlobStore, emptyStore, scopedBlobs, sqliteStore } from './store.sqlite'
