import { expect, test } from 'vitest'
import { deleteAccount } from './account'
import { addAccount, testDatabase } from './test-db'

test('the migration creates the four account tables', () => {
	const { sqlite } = testDatabase()
	const tables = sqlite
		.prepare(
			`SELECT name FROM sqlite_schema
			 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
			 ORDER BY name`
		)
		.all()

	expect(tables).toEqual([
		{ name: 'accounts' },
		{ name: 'app_grants' },
		{ name: 'oauth_flows' },
		{ name: 'sessions' }
	])
})

test('deleting an account removes its grants and sessions', async () => {
	const { database, sqlite } = testDatabase()
	await addAccount(database)
	await database.run(
		`INSERT INTO app_grants (user_id, app_id, capability_hash, resources)
		 VALUES ('user_1', 'alice.notes', 'hash', '[]')`
	)
	await database.run(
		`INSERT INTO sessions (id_hash, kind, user_id, expires_at)
		 VALUES ('root-session', 'root', 'user_1', 1000)`
	)
	await deleteAccount(database, 'user_1')

	expect(sqlite.prepare('SELECT * FROM app_grants').all()).toEqual([])
	expect(sqlite.prepare('SELECT * FROM sessions').all()).toEqual([])
})
