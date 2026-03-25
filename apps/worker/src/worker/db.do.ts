import type {
	DbAdapter,
	EmbeddingProvider,
	LLM,
	Reranker,
	SqlValue,
	Store,
	VectorStore
} from '@ghostore/core'
import { createStore, migrateFromEntries } from '@ghostore/core'
import { coreMigrations } from '@ghostore/core/migrations'

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
	await migrateFromEntries(createDOSqliteAdapter(storage), coreMigrations)
}

export function cfStore(
	storage: DurableObjectStorage,
	namespace: string,
	embProvider?: EmbeddingProvider,
	llm?: LLM,
	reranker?: Reranker,
	vectorStore?: VectorStore
): Store {
	return createStore(createDOSqliteAdapter(storage), namespace, embProvider, llm, reranker, vectorStore)
}
