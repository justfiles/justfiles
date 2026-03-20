import type { EmbeddingProvider } from '../core/embedding'
import type { LLM } from '../core/llm'
import type { Reranker } from '../core/reranker'
import type { DbAdapter, SqlValue } from '../core/db'
import { migrateFromEntries, createStore } from '../core/store'
import type { Store } from '../core/store'

// Wrangler's Text rule (globs: ["**/*.sql"]) bundles .sql files as plain strings.
// @ts-ignore
import MIGRATION_0001 from '../core/migrations/0001_schema.sql'
// @ts-ignore
import MIGRATION_0002 from '../core/migrations/0002_dirty_flag.sql'

const MIGRATIONS: Array<{ version: number; sql: string }> = [
	{ version: 1, sql: MIGRATION_0001 as string },
	{ version: 2, sql: MIGRATION_0002 as string },
]

// CF DO prohibits SQL BEGIN/COMMIT; use storage.transactionSync() instead.
// Since our transactions contain only writes (no reads-inside-transaction),
// we collect write ops during the async fn, then replay them in transactionSync.
function createDOSqliteAdapter(storage: DurableObjectStorage): DbAdapter {
	const { sql } = storage
	const adapter: DbAdapter = {
		async query<T extends Record<string, unknown>>(query: string, args: SqlValue[] = []): Promise<T[]> {
			return sql.exec(query, ...args).toArray() as unknown as T[]
		},
		async run(query: string, args: SqlValue[] = []): Promise<void> {
			sql.exec(query, ...args)
		},
		async transaction(fn: (tx: DbAdapter) => Promise<void>): Promise<void> {
			const ops: Array<{ q: string; args: SqlValue[] }> = []
			const txAdapter: DbAdapter = {
				async query<T extends Record<string, unknown>>(query: string, args: SqlValue[] = []): Promise<T[]> {
					return sql.exec(query, ...args).toArray() as unknown as T[]
				},
				async run(query: string, args: SqlValue[] = []): Promise<void> {
					ops.push({ q: query, args })
				},
				async transaction(innerFn) {
					await innerFn(txAdapter)
				}
			}
			await fn(txAdapter)
			storage.transactionSync(() => {
				for (const op of ops) sql.exec(op.q, ...op.args)
			})
		}
	}
	return adapter
}

export async function migrateCF(storage: DurableObjectStorage): Promise<void> {
	await migrateFromEntries(createDOSqliteAdapter(storage), MIGRATIONS)
}

export function cfStore(
	storage: DurableObjectStorage,
	embProvider?: EmbeddingProvider,
	llm?: LLM,
	reranker?: Reranker
): Store {
	return createStore(createDOSqliteAdapter(storage), embProvider, llm, reranker)
}
