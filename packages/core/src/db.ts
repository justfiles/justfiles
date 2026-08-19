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
 * A dynamic `IN`-list bound as ONE parameter: write `WHERE x IN ${IN_LIST}` and bind
 * `JSON.stringify(values)`.
 *
 * NEVER build `IN (?, ?, …)` over a list whose length the caller controls. Durable
 * Object SQLite binds at most 100 parameters per statement, and one more fails the
 * whole statement with `too many SQL variables` — while a scan page is 200 rows and a
 * sync snapshot page is whatever `limit` the peer asked for. `json_each` costs one
 * parameter at any length, and the left operand's affinity still applies, so a TEXT
 * key matches a JSON string exactly as `?` did.
 */
export const IN_LIST = '(SELECT value FROM json_each(?))'
