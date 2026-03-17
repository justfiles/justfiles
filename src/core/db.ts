// Unified adapter interface over bun:sqlite and @libsql/client.
// All methods are async so the interface works with both sync (bun:sqlite) and
// async (libsql) backends.

export type SqlValue = null | string | number | bigint | Uint8Array | ArrayBuffer

export interface DbAdapter {
	query<T extends Record<string, unknown> = Record<string, unknown>>(
		sql: string,
		args?: SqlValue[]
	): Promise<T[]>
	run(sql: string, args?: SqlValue[]): Promise<void>
	transaction(fn: (tx: DbAdapter) => Promise<void>): Promise<void>
}
