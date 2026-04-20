import type { DbAdapter, SqlValue } from './db'

interface BunDatabase {
	prepare(sql: string): { all(...args: SqlValue[]): unknown[]; run(...args: SqlValue[]): void }
	exec(sql: string): void
}

export function createSqliteAdapter(db: BunDatabase): DbAdapter {
	db.exec('PRAGMA foreign_keys = ON')

	const adapter: DbAdapter = {
		async query<T extends Record<string, unknown>>(
			sql: string,
			args: SqlValue[] = []
		): Promise<T[]> {
			return db.prepare(sql).all(...args) as T[]
		},
		async run(sql: string, args: SqlValue[] = []): Promise<void> {
			db.prepare(sql).run(...args)
		},
		async transaction(fn: (tx: DbAdapter) => Promise<void>): Promise<void> {
			db.exec('BEGIN')
			try {
				await fn(adapter)
				db.exec('COMMIT')
			} catch (e) {
				db.exec('ROLLBACK')
				throw e
			}
		}
	}
	return adapter
}
