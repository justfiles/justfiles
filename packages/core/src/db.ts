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
