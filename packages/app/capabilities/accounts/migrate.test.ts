import { memStorage, type Volume, volume } from '@justfiles/fs'
import { describe, expect, test } from 'vitest'
import { accountsStoreOverConnections } from './account-view.ts'
import { volumeActiveAi } from './active-ai.ts'
import { volumeConnectionStore } from './connection.ts'
import { migrateAccountsToConnections } from './migrate.ts'
import { CALENDAR_SCOPE, GMAIL_SCOPE } from './provider-caps.ts'
import { type Account, volumeAccountsStore } from './store.ts'

const account = (over: Partial<Account> = {}): Account => ({
	accountId: 'u@openai.com',
	providerId: 'chatgpt',
	creds: { access: 'tok', refresh: 'ref' },
	enabled: {},
	...over
})

async function seedLegacy(fs: Volume, accounts: Account[]) {
	const legacy = volumeAccountsStore(fs)
	for (const a of accounts) await legacy.put(a)
}

describe('migrateAccountsToConnections', () => {
	test('moves legacy accounts into connections + the active-AI selection', async () => {
		const fs = volume(memStorage())
		const google = account({
			accountId: 'g',
			providerId: 'google',
			enabled: { email: {}, calendar: {} },
			scopes: [GMAIL_SCOPE, CALENDAR_SCOPE]
		})
		const chatgpt = account({ enabled: { ai: { model: 'gpt-x' } } })
		await seedLegacy(fs, [google, chatgpt])

		await migrateAccountsToConnections(fs)

		// connections carry the creds/scopes; the ai selection carries enablement
		expect((await volumeConnectionStore(fs).list()).map((c) => c.id).sort()).toEqual([
			'g',
			'u@openai.com'
		])
		expect(await volumeActiveAi(fs).get()).toEqual({ connectionId: 'u@openai.com', model: 'gpt-x' })

		// the account-centric view reproduces the original accounts
		const view = accountsStoreOverConnections(volumeConnectionStore(fs), volumeActiveAi(fs))
		const byId = (a: Account, b: Account) => a.accountId.localeCompare(b.accountId)
		expect((await view.list()).sort(byId)).toEqual([google, chatgpt].sort(byId))
	})

	test('is idempotent — a second run leaves connections untouched', async () => {
		const fs = volume(memStorage())
		await seedLegacy(fs, [account({ enabled: { ai: {} } })])
		await migrateAccountsToConnections(fs)
		const first = await volumeConnectionStore(fs).list()
		await migrateAccountsToConnections(fs)
		expect(await volumeConnectionStore(fs).list()).toEqual(first)
	})

	test('no-op when there are no legacy accounts', async () => {
		const fs = volume(memStorage())
		await migrateAccountsToConnections(fs)
		expect(await volumeConnectionStore(fs).list()).toEqual([])
	})
})
