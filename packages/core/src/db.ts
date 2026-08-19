// Unified adapter interface for SQLite-backed storage adapters.
// All methods are async so the interface works with both sync and async
// implementations.

export type SqlValue = null | string | number | bigint | Uint8Array | ArrayBuffer

export interface DbAdapter {
	query<T extends Record<string, unknown> = Record<string, unknown>>(
		sql: string,
		args?: SqlValue[]
	): Promise<T[]>
	run(sql: string, args?: SqlValue[]): Promise<void>
	transaction(fn: (tx: DbAdapter) => Promise<void>): Promise<void>
}

/**
 * The same database, synchronously — the seam a genuinely ATOMIC transaction needs.
 *
 * `DbAdapter.transaction` cannot promise one everywhere: on a Durable Object it is a bare
 * `await fn(adapter)`, so a body that fails halfway leaves the statements before it written.
 * `storage.transactionSync` is the only transaction there that rolls back, and it takes a
 * synchronous body — an awaited one would commit before the awaited statements ran. Both
 * drivers underneath were synchronous all along (`node:sqlite`, `sql.exec`), so this asks
 * for nothing new of them; it only stops throwing the guarantee away.
 *
 * `migrateSync`'s `SyncMigrator` is the same shape, deliberately: one object satisfies both,
 * which is how a host runs its migrations and its store over one seam.
 */
export interface SyncDb {
	exec(sql: string, args?: SqlValue[]): void
	query<T extends Record<string, unknown> = Record<string, unknown>>(
		sql: string,
		args?: SqlValue[]
	): T[]
	/** Run `fn` as ONE atomic transaction; roll it back wholesale if it throws. */
	transactionSync(fn: () => void): void
}
