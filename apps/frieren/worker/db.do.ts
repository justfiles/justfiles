/**
 * DO SQLite adapter for @justfiles/core sqliteStorage.
 * Copied from apps/worker/src/worker/db.do.ts — same pattern.
 */
import type { DbAdapter, SqlValue } from '@justfiles/core'
import { migrateSync, sqliteStorage } from '@justfiles/core'
import { coreMigrations } from '@justfiles/core/migrations'
import type { Storage } from '@justfiles/fs/storage'

type BlobObject = {
	arrayBuffer(): Promise<ArrayBuffer>
}

type BlobStore = {
	put(
		key: string,
		value: ArrayBuffer | ArrayBufferView | string | Blob,
		options?: {
			httpMetadata?: { contentType?: string }
			customMetadata?: Record<string, string>
		}
	): Promise<unknown>
	get(key: string): Promise<BlobObject | null>
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

export async function migrateCF(storage: DurableObjectStorage): Promise<void> {
	const { sql } = storage
	sql.exec('PRAGMA foreign_keys = ON')
	// Synchronous + `transactionSync` so each migration's statements and its
	// `schema_migrations` record commit atomically (the DbAdapter's `transaction` is a
	// no-op on the DO, so an interrupted migration would otherwise half-apply and brick
	// later ones — e.g. a re-run `ALTER TABLE ADD COLUMN` failing as a duplicate).
	migrateSync(
		{
			exec: (query, args = []) => {
				sql.exec(query, ...normalizeArgs(args))
			},
			query: (query) => sql.exec(query).toArray() as Array<Record<string, unknown>>,
			transactionSync: (fn) => {
				storage.transactionSync(fn)
			}
		},
		coreMigrations
	)
}

export function cfFsStorage(adapter: DbAdapter, namespace: string, blobStore?: BlobStore): Storage {
	return sqliteStorage(adapter, { namespace, blobStore })
}
