export type { DbAdapter, SqlValue, SyncDb } from './db'
export { createSqliteAdapter, createSqliteSyncDb } from './db.sqlite'
export { fileApi } from './file.api'
export {
	createFsApi,
	type DestructiveResetBody,
	ResetBody,
	type ResetResult
} from './fs'
export type { FsApiType, FsClient, FsClientOptions, RemoteSyncReplicaOptions } from './fs.client'
export { apiStorage, createFsClient, remoteSyncReplica } from './fs.client'
export { migrateSqlite } from './migrate.sqlite'
export { migrateSync, parseSqlStatements, type SyncMigrator } from './migrations/utils'
export {
	clearReset,
	decideReset,
	type GenerationState,
	type ResetDecision,
	type ResetMode,
	type ResetStatus,
	type ResetStores,
	readGeneration,
	readGenerationState,
	readResetStatus,
	resetStore,
	resetVolume
} from './reset'
export { storage as sqliteStorage } from './storage.sqlite'
// The server half of the seam, unexported until now on purpose: half a server
// surface is no use to anyone, and this is where the first consumer arrives.
export { storeApi } from './store.api'
export { emptyStore, sqliteStore } from './store.sqlite'
