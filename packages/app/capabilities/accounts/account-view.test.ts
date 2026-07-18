import { memStorage, type Volume, volume } from '@justfiles/fs'
import { describe, expect, test } from 'vitest'
import { accountsStoreOverConnections } from './account-view.ts'
import { volumeActiveAi } from './active-ai.ts'
import { volumeConnectionStore } from './connection.ts'
import { CALENDAR_SCOPE, GMAIL_SCOPE } from './provider-caps.ts'
import type { Account } from './store.ts'

// The shim presents the legacy AccountsStore shape over connection storage +
// the active-AI selection. Enablement is derived (scopes for email/calendar, the
// active-AI pointer for ai) — there is no separate wiring table.
function view(fs: Volume) {
	return accountsStoreOverConnections(volumeConnectionStore(fs), volumeActiveAi(fs))
}

const account = (over: Partial<Account> = {}): Account => ({
	accountId: 'u@openai.com',
	providerId: 'chatgpt',
	creds: { access: 'tok', refresh: 'ref' },
	enabled: {},
	...over
})

describe('accountsStoreOverConnections', () => {
	test('round-trips an ai account (creds → connection, ai → active-AI selection)', async () => {
		const fs = volume(memStorage())
		const store = view(fs)
		const a = account({ enabled: { ai: { model: 'gpt-x' } } })
		await store.put(a)

		expect(await store.get('u@openai.com')).toEqual(a)
		expect(await store.list()).toEqual([a])
		expect(await volumeConnectionStore(fs).get('u@openai.com')).toEqual({
			id: 'u@openai.com',
			kind: 'chatgpt',
			creds: { access: 'tok', refresh: 'ref' }
		})
		expect(await volumeActiveAi(fs).get()).toEqual({ connectionId: 'u@openai.com', model: 'gpt-x' })
	})

	test('email/calendar enablement is carried by the connection scopes', async () => {
		const fs = volume(memStorage())
		const store = view(fs)
		const google = (enabled: Account['enabled'], scopes?: string[]) =>
			account({ accountId: 'g', providerId: 'google', enabled, scopes })

		await store.put(google({ email: {}, calendar: {} }, [GMAIL_SCOPE, CALENDAR_SCOPE]))
		expect((await store.get('g'))?.enabled).toEqual({ email: {}, calendar: {} })

		// disabling email drops its scope; calendar stays
		await store.put(google({ calendar: {} }, [GMAIL_SCOPE, CALENDAR_SCOPE]))
		expect((await store.get('g'))?.enabled).toEqual({ calendar: {} })
		expect((await store.get('g'))?.scopes).toEqual([CALENDAR_SCOPE])
	})

	test('ai is single-active: pointing it at a new account frees the old one', async () => {
		const fs = volume(memStorage())
		const store = view(fs)
		await store.put(account({ accountId: 'a', enabled: { ai: {} } }))
		await store.put(account({ accountId: 'b', enabled: { ai: { model: 'm' } } }))

		expect(await volumeActiveAi(fs).get()).toEqual({ connectionId: 'b', model: 'm' })
		expect((await store.get('a'))?.enabled).toEqual({})
		expect((await store.get('b'))?.enabled).toEqual({ ai: { model: 'm' } })
	})

	test('delete removes the connection and clears the active-AI pointer', async () => {
		const fs = volume(memStorage())
		const store = view(fs)
		await store.put(
			account({
				accountId: 'g',
				providerId: 'google',
				enabled: { email: {} },
				scopes: [GMAIL_SCOPE]
			})
		)
		await store.put(account({ accountId: 'x', enabled: { ai: {} } }))

		await store.delete('g')
		await store.delete('x')
		expect(await store.list()).toEqual([])
		expect(await volumeActiveAi(fs).get()).toBeNull()
	})
})
