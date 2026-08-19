/**
 * A Durable Object's SQLite, in the two shapes the store model asks for.
 *
 * Structurally typed rather than against `DurableObjectStorage`, for the reason
 * `db.sqlite.ts` types `node:sqlite` structurally: this package owns the schema and the
 * store that runs on it, not a runtime.
 *
 * TWO shapes, and only for as long as there are two models. `SyncDb` is what the store
 * itself speaks — `transactionSync` is the only genuinely atomic transaction a Durable
 * Object has, and it takes a synchronous body. The async `DbAdapter` is what the old
 * tables are read through: the generation row, and the one pass out of them. It leaves
 * with them.
 */

import type { DbAdapter, SqlValue, SyncDb } from './db'

/**
 * As much of `DurableObjectStorage` as either seam touches. A Durable Object's own
 * type satisfies it, so a host hands its `ctx.storage` straight in.
 */
export type DoStorage = {
	sql: { exec(query: string, ...args: unknown[]): { toArray(): unknown[] } }
	transactionSync<T>(fn: () => T): T
}

/**
 * The synchronous seam: what an atomic transaction needs.
 *
 * Two callers, for one reason. The migration runner needed it first — an interrupted
 * migration that half-applied would brick every later one — and `sqliteStore` needs it
 * at a smaller scale: a guard evaluated in a transaction the writes do not share is a
 * race, and a write that fails mid-batch must take the rows before it out with it.
 */
export function createDoSyncDb(storage: DoStorage): SyncDb {
	const { sql } = storage
	sql.exec('PRAGMA foreign_keys = ON')
	return {
		exec: (query, args = []) => {
			sql.exec(query, ...args.map(plain))
		},
		query: <T extends Record<string, unknown>>(query: string, args: SqlValue[] = []) =>
			sql.exec(query, ...args.map(plain)).toArray() as T[],
		transactionSync: (fn) => {
			storage.transactionSync(fn)
		}
	}
}

/** The async seam, for the readers of the OLD tables and nothing else. */
export function createDoAdapter(storage: DoStorage): DbAdapter {
	const { sql } = storage
	sql.exec('PRAGMA foreign_keys = ON')
	const adapter: DbAdapter = {
		async query<T extends Record<string, unknown>>(query: string, args: SqlValue[] = []) {
			return sql.exec(query, ...args.map(plain)).toArray() as T[]
		},
		async run(query: string, args: SqlValue[] = []) {
			sql.exec(query, ...args.map(plain))
		},
		// Cloudflare rejects a manual BEGIN/COMMIT and `transactionSync` needs a
		// synchronous body, so this is the event's implicit transaction and nothing more.
		// Its remaining callers are a read and a resumable idempotent pass, which is what
		// makes that enough for them — `createDoSyncDb` is what a WRITE that must be
		// atomic takes.
		async transaction(fn: (tx: DbAdapter) => Promise<void>) {
			await fn(adapter)
		}
	}
	return adapter
}

/** The DO's SQL takes no bigint; every 64-bit field is decimal TEXT on the way in. */
const plain = (arg: SqlValue) => (typeof arg === 'bigint' ? arg.toString() : arg)
