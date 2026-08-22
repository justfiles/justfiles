import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import type { Database } from './db'

export function testDatabase() {
	const sqlite = new DatabaseSync(':memory:')
	const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url).href)
	for (const file of readdirSync(migrations).sort())
		sqlite.exec(readFileSync(`${migrations}/${file}`, 'utf8'))
	const database: Database = {
		async first<T>(sql: string, ...values: (string | number | null)[]) {
			return (sqlite.prepare(sql).get(...values) as T | undefined) ?? null
		},
		async run(sql: string, ...values: (string | number | null)[]) {
			return Number(sqlite.prepare(sql).run(...values).changes)
		},
		async batch(statements) {
			sqlite.exec('BEGIN IMMEDIATE')
			try {
				const changes = statements.map(({ sql, values }) =>
					Number(sqlite.prepare(sql).run(...values).changes)
				)
				sqlite.exec('COMMIT')
				return changes
			} catch (error) {
				sqlite.exec('ROLLBACK')
				throw error
			}
		}
	}
	const statement = (sql: string, values: (string | number | null)[] = []) => ({
		sql,
		values,
		bind(...next: (string | number | null)[]) {
			return statement(sql, next)
		},
		async first<T>() {
			return database.first<T>(sql, ...values)
		},
		async run() {
			return { meta: { changes: await database.run(sql, ...values) } }
		}
	})
	const binding = {
		prepare: (sql: string) => statement(sql),
		batch: async (statements: ReturnType<typeof statement>[]) =>
			(await database.batch(statements)).map((changes) => ({ meta: { changes } }))
	} as unknown as D1Database
	return { database, binding, sqlite }
}

export async function addAccount(database: Database, userId = 'user_1') {
	await database.run(
		`INSERT INTO accounts
			(user_id, access_token, refresh_token, access_expires_at, scopes)
		 VALUES (?, 'access', 'refresh', 0, '[]')`,
		userId
	)
}
