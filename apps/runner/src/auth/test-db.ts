import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import type { Database } from './db'

export function testDatabase() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		readFileSync(
			fileURLToPath(new URL('../../migrations/0001_auth.sql', import.meta.url).href),
			'utf8'
		)
	)
	const database: Database = {
		async first<T>(sql: string, ...values: (string | number | null)[]) {
			return (sqlite.prepare(sql).get(...values) as T | undefined) ?? null
		},
		async run(sql: string, ...values: (string | number | null)[]) {
			return Number(sqlite.prepare(sql).run(...values).changes)
		}
	}
	return { database, sqlite }
}

export async function addAccount(database: Database, userId = 'user_1') {
	await database.run(
		`INSERT INTO accounts
			(user_id, access_token, refresh_token, access_expires_at, scopes)
		 VALUES (?, 'access', 'refresh', 0, '[]')`,
		userId
	)
}
