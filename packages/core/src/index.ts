export type { DbAdapter, SqlValue, SyncDb } from './db'
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
export { storeApi } from './store.api'
export { emptyStore, sqliteStore } from './store.sqlite'
// NOT exported: `storage.sqlite.ts`. It is the old model's backend, and nothing in
// production reaches it now that both hosts serve the seam — it survives only as the
// fixture `migrate.sqlite.test.ts` builds the old tree with, which imports it by path.
// T18 deletes it, and `@justfiles/sync` (a devDependency for exactly that fixture)
// leaves with it.
