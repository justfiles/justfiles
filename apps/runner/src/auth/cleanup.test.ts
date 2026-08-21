import { expect, test } from 'vitest'
import { cleanExpired } from './cleanup'
import { beginFlow } from './flow'
import { createSession } from './session'
import { addAccount, testDatabase } from './test-db'

test('deletes expired flows, tickets, and sessions', async () => {
	const { database, sqlite } = testDatabase()
	await addAccount(database)
	await beginFlow(database, 'old.app', 0)
	await beginFlow(database, 'live.app', 10_000)
	await createSession(database, { kind: 'ticket', userId: 'user_1', appId: 'old.app' }, 0)
	await createSession(database, { kind: 'root', userId: 'user_1' }, 10_000)

	expect(await cleanExpired(database, 10 * 60 * 1000)).toBe(2)
	expect(sqlite.prepare('SELECT app_id FROM oauth_flows').all()).toEqual([{ app_id: 'live.app' }])
	expect(sqlite.prepare('SELECT kind FROM sessions').all()).toEqual([{ kind: 'root' }])
})
