// @ts-ignore Bun resolves this at runtime; TypeScript in this workspace does not.
import { Database } from 'bun:sqlite'
import { resolve } from 'node:path'
import { coreMigrations } from './migrations'
import type { EmbeddingProvider } from './embedding'
import type { LLM } from './llm'
import type { Reranker } from './reranker'
import type { Store } from './store'
import { createSqliteAdapter } from './db.sqlite'
import { migrateFromEntries, createStore } from './store'

async function migrate(adapter: ReturnType<typeof createSqliteAdapter>): Promise<void> {
	await migrateFromEntries(adapter, coreMigrations)
}

export async function sqliteStore(
	dbPath: string,
	embProvider?: EmbeddingProvider,
	llm?: LLM,
	reranker?: Reranker
): Promise<Store> {
	const db = new Database(resolve(dbPath))
	db.exec('PRAGMA foreign_keys = ON')
	db.exec('PRAGMA journal_mode = WAL')
	const adapter = createSqliteAdapter(db)
	await migrate(adapter)
	return createStore(adapter, 'default', embProvider, llm, reranker)
}
