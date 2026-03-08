import { Database } from 'bun:sqlite'
import { resolve } from 'node:path'
import type { EmbeddingProvider } from '../embedding'
import type { QueryExpander } from '../llm'
import type { Store } from './types'
import { createSqliteAdapter } from './db-adapter'
import { migrate, createStore } from './store-impl'

export async function sqliteStore(
	dbPath: string,
	embProvider?: EmbeddingProvider,
	queryExpander?: QueryExpander
): Promise<Store> {
	const db = new Database(resolve(dbPath))
	db.exec('PRAGMA foreign_keys = ON')
	db.exec('PRAGMA journal_mode = WAL')
	const adapter = createSqliteAdapter(db)
	await migrate(adapter)
	return createStore(adapter, embProvider, queryExpander)
}
