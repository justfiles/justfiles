/**
 * DO SQLite adapter for @justfiles/core sqliteStorage.
 * Copied from apps/worker/src/worker/db.do.ts — same pattern.
 */
import type { DbAdapter, SqlValue } from '@justfiles/core'
import { migrateFromEntries, sqliteStorage } from '@justfiles/core'
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
	delete?(key: string): Promise<void>
}

export function createDOSqliteAdapter(storage: DurableObjectStorage): DbAdapter {
	const { sql } = storage
	sql.exec('PRAGMA foreign_keys = ON')
	const normalizeArgs = (
		args: SqlValue[]
	): Array<null | string | number | Uint8Array | ArrayBuffer> =>
		args.map((arg) => (typeof arg === 'bigint' ? arg.toString() : arg))
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
		// The DO runs one event at a time (input/output gates) and our storage does no
		// network I/O between statements, so a whole mutation's `sql.exec` calls commit
		// together as the event's implicit transaction. Cloudflare's SQL API rejects a
		// manual `BEGIN`/`COMMIT`, and `ctx.storage.transactionSync` needs a SYNCHRONOUS
		// body (ours is async), so this stays the implicit form. The reset body is
		// proven atomic against the real BEGIN/COMMIT adapter (db.sqlite.ts) in
		// reset.test.ts; full crash-atomicity on the DO awaits a sync-storage refactor
		// (see docs/sync-reset-generation.md — "test the path, not the guarantee").
		async transaction(fn: (tx: DbAdapter) => Promise<void>): Promise<void> {
			await fn(adapter)
		}
	}
	return adapter
}

export async function migrateCF(adapter: DbAdapter): Promise<void> {
	await migrateFromEntries(adapter, coreMigrations)
}

export function cfFsStorage(adapter: DbAdapter, namespace: string, blobStore?: BlobStore): Storage {
	return sqliteStorage(adapter, { namespace, blobStore })
}
