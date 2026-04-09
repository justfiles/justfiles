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

// SQLite-backed Durable Objects already provide atomic read/write isolation for
// storage operations with no intervening non-storage I/O. We keep the adapter
// thin so higher layers can perform transactional read-modify-write flows.
function createDOSqliteAdapter(storage: DurableObjectStorage): DbAdapter {
	const { sql } = storage
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
	blobStore?: BlobStore
): Storage {
	return sqliteStorage(createDOSqliteAdapter(storage), { namespace, blobStore })
}
