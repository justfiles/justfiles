/**
 * This Durable Object's SQLite, in the two shapes the store model asks for.
 * The same pair apps/worker keeps — see the note there.
 */
import type { DbAdapter, SqlValue, SyncDb } from '@justfiles/core'
import { migrateSync } from '@justfiles/core'
import { coreMigrations } from '@justfiles/core/migrations'

type BlobStore = {
	put(key: string, value: ArrayBuffer | ArrayBufferView): Promise<unknown>
	get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>
	delete?(keys: string | string[]): Promise<void>
}

const normalizeArgs = (
	args: SqlValue[]
): Array<null | string | number | Uint8Array | ArrayBuffer> =>
	args.map((arg) => (typeof arg === 'bigint' ? arg.toString() : arg))

export function createDOSqliteAdapter(storage: DurableObjectStorage): DbAdapter {
	const { sql } = storage
	sql.exec('PRAGMA foreign_keys = ON')
	const adapter: DbAdapter = {
		async query<T extends Record<string, unknown>>(
			query: string,
			args: SqlValue[] = []
		): Promise<T[]> {
			return sql.exec(query, ...normalizeArgs(args)).toArray() as unknown as T[]
		},
		async run(query: string, args: SqlValue[] = []): Promise<void> {
			sql.exec(query, ...normalizeArgs(args))
		},
		// The DO runs one event at a time and does no network I/O between statements,
		// so a mutation's `sql.exec` calls commit together as the event's implicit
		// transaction. Cloudflare rejects a manual `BEGIN`/`COMMIT` and
		// `transactionSync` needs a synchronous body (ours is async), so this stays the
		// implicit form — reset.test.ts proves the reset body atomic against the real
		// BEGIN/COMMIT adapter. Full crash-atomicity awaits a sync-storage refactor.
		async transaction(fn: (tx: DbAdapter) => Promise<void>): Promise<void> {
			await fn(adapter)
		}
	}
	return adapter
}

/**
 * The same storage as a `SyncDb`: `transactionSync` is the only genuinely ATOMIC
 * transaction a Durable Object has, and it takes a synchronous body.
 *
 * One seam, two callers, deliberately. The migration runner needed it first — an
 * interrupted migration that half-applied would brick every later one — and
 * `sqliteStore` needs it for the same reason at a smaller scale: a guard evaluated
 * in a transaction the writes do not share is a race, and a write that fails
 * mid-batch must take the rows before it out with it (rule 2).
 */
export function createDOSyncDb(storage: DurableObjectStorage): SyncDb {
	const { sql } = storage
	sql.exec('PRAGMA foreign_keys = ON')
	return {
		exec: (query, args = []) => {
			sql.exec(query, ...normalizeArgs(args))
		},
		query: <T extends Record<string, unknown>>(query: string, args: SqlValue[] = []) =>
			sql.exec(query, ...normalizeArgs(args)).toArray() as unknown as T[],
		transactionSync: (fn) => {
			storage.transactionSync(fn)
		}
	}
}

export async function migrateCF(storage: DurableObjectStorage): Promise<void> {
	// Synchronous + `transactionSync` so each migration's statements and its
	// `schema_migrations` record commit atomically (the DbAdapter's `transaction` is a
	// no-op on the DO, so an interrupted migration would otherwise half-apply and brick
	// later ones — e.g. a re-run `ALTER TABLE ADD COLUMN` failing as a duplicate).
	migrateSync(createDOSyncDb(storage), coreMigrations)
}

/**
 * This instance's own corner of the shared bucket.
 *
 * One R2 bucket serves every Durable Object, and `sqliteStore` keys an object by its
 * store id and hash — which two users would collide on. Scoping is the HOST's job
 * because only the host knows what it is one of, so this is where that name is added
 * and the only place that knows the layout.
 */
export function scopedBlobs(bucket: BlobStore | undefined, namespace: string) {
	if (!bucket) return undefined
	const at = (key: string) => `${namespace}/store/${key}`
	return {
		put: (key: string, value: ArrayBuffer | ArrayBufferView) => bucket.put(at(key), value),
		get: (key: string) => bucket.get(at(key)),
		delete: async (keys: string | string[]) =>
			bucket.delete?.(typeof keys === 'string' ? at(keys) : keys.map(at))
	}
}
