/**
 * DO SQLite adapter for @justfiles/core sqliteStorage.
 * Copied from apps/worker/src/worker/db.do.ts — same pattern.
 */
import type { DbAdapter, SqlValue } from '@justfiles/core'
import { migrateFromEntries, sqliteStorage } from '@justfiles/core'
import { coreMigrations } from '@justfiles/core/migrations'
import type { Storage } from '@justfiles/fs/storage'

function createDOSqliteAdapter(storage: DurableObjectStorage): DbAdapter {
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
		async transaction(fn: (tx: DbAdapter) => Promise<void>): Promise<void> {
			await fn(adapter)
		}
	}
	return adapter
}

export async function migrateCF(storage: DurableObjectStorage): Promise<void> {
	await migrateFromEntries(createDOSqliteAdapter(storage), coreMigrations)
}

export function cfFsStorage(
	storage: DurableObjectStorage,
	namespace: string,
): Storage {
	return sqliteStorage(createDOSqliteAdapter(storage), { namespace })
}
