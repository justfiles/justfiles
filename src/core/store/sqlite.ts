import { readFileSync, readdirSync } from 'node:fs'
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Database } from 'bun:sqlite'
import { resolve } from 'node:path'
import type { EmbeddingProvider } from '../embedding'
import type { LLM } from '../llm'
import type { Store } from './types'
import { createSqliteAdapter } from './db-adapter'
import { migrateFromEntries, createStore } from './store-impl'

async function migrate(adapter: ReturnType<typeof createSqliteAdapter>): Promise<void> {
	const migrationDir = fileURLToPath(new URL('./migrations', import.meta.url).toString())
	const entries = readdirSync(migrationDir)
		.filter((name: string) => /^\d{4}_.*\.sql$/.test(name))
		.sort()
		.map((file: string) => ({
			version: parseInt(file.slice(0, 4), 10),
			sql: readFileSync(`${migrationDir}${sep}${file}`, 'utf8')
		}))
	await migrateFromEntries(adapter, entries)
}

export async function sqliteStore(
	dbPath: string,
	embProvider?: EmbeddingProvider,
	llm?: LLM
): Promise<Store> {
	const db = new Database(resolve(dbPath))
	db.exec('PRAGMA foreign_keys = ON')
	db.exec('PRAGMA journal_mode = WAL')
	const adapter = createSqliteAdapter(db)
	await migrate(adapter)
	return createStore(adapter, embProvider, llm)
}
