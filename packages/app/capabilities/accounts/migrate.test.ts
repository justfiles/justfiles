import { memStorage, type Volume, volume } from '@justfiles/fs'
import { describe, expect, test } from 'vitest'
import { volumeActiveAi } from './active-ai.ts'
import { volumeConnectionStore } from './connection.ts'
import { migrateAccountsToConnections } from './migrate.ts'
import { backs, CALENDAR_SCOPE, GMAIL_SCOPE } from './provider-caps.ts'
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

		// connections carry the creds/scopes; capabilities are derived from scopes …
		const conns = await volumeConnectionStore(fs).list()
		expect(conns.map((c) => c.id).sort()).toEqual(['g', 'u@openai.com'])
		const g = conns.find((c) => c.id === 'g')
		expect(g && backs(g, 'email')).toBe(true)
		expect(g && backs(g, 'calendar')).toBe(true)
		// … and the ai selection carries enablement + the model.
		expect(await volumeActiveAi(fs).get()).toEqual({ connectionId: 'u@openai.com', model: 'gpt-x' })
	})

	test('reconstructs missing scopes from the enabled set', async () => {
		const fs = volume(memStorage())
		// A pre-scopes google account: enabled email but no `scopes` recorded.
		await seedLegacy(fs, [
			account({ accountId: 'g', providerId: 'google', enabled: { email: {} } })
		])
		await migrateAccountsToConnections(fs)
		const g = (await volumeConnectionStore(fs).list()).find((c) => c.id === 'g')
		expect(g?.scopes).toEqual([GMAIL_SCOPE])
		expect(g && backs(g, 'email')).toBe(true)
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
