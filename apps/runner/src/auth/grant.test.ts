import { expect, test } from 'vitest'
import { putGrant, readGrant, revokeGrant } from './grant'
import { addAccount, testDatabase } from './test-db'

test('stores one current grant for an app and revokes it', async () => {
	const { database } = testDatabase()
	await addAccount(database)
	await putGrant(database, {
		userId: 'user_1',
		appId: 'alice.notes',
		capabilityHash: 'sha256-capabilities',
		resources: ['volume', 'ai', 'volume']
	})

	expect(await readGrant(database, 'user_1', 'alice.notes')).toEqual({
		userId: 'user_1',
		appId: 'alice.notes',
		capabilityHash: 'sha256-capabilities',
		resources: ['ai', 'volume']
	})
	await revokeGrant(database, 'user_1', 'alice.notes', 5_000)
	expect(await readGrant(database, 'user_1', 'alice.notes')).toBeNull()
})
