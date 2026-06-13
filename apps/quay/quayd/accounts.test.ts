import type { Account } from '@justfiles/app/capabilities/accounts/host'
import { memStorage, volume } from '@justfiles/fs'
import { describe, expect, test } from 'vitest'
import { volumeAccountsStore } from './accounts.ts'
import { resolveAi } from './chatgpt.ts'

// quay's accounts store rides the Volume (one JSON file per account) and the
// agent's `resolveAi` reads the ai-enabled ChatGPT account straight from it. Both
// are exercised against a real in-memory Volume.

const chatgpt = (over: Partial<Account> = {}): Account => ({
	accountId: 'u@openai.com',
	providerId: 'chatgpt',
	creds: {
		access: 'tok',
		refresh: 'ref',
		expires: Date.now() + 3_600_000,
		accountId: 'u@openai.com'
	},
	enabled: {},
	...over
})

describe('volumeAccountsStore', () => {
	test('round-trips accounts and lists them; delete removes one', async () => {
		const store = volumeAccountsStore(volume(memStorage()))
		expect(await store.list()).toEqual([])

		const account = chatgpt({ enabled: { ai: { model: 'gpt-x' } } })
		await store.put(account)
		expect(await store.get('u@openai.com')).toEqual(account)
		expect(await store.list()).toEqual([account])

		await store.delete('u@openai.com')
		expect(await store.get('u@openai.com')).toBeUndefined()
		expect(await store.list()).toEqual([])
	})

	test('get is undefined for an unknown account', async () => {
		const store = volumeAccountsStore(volume(memStorage()))
		expect(await store.get('nobody')).toBeUndefined()
	})
})

describe('resolveAi', () => {
	test('returns null when no ChatGPT account has ai enabled', async () => {
		const store = volumeAccountsStore(volume(memStorage()))
		await store.put(chatgpt()) // connected but ai not enabled
		expect(await resolveAi(store)).toBeNull()
	})

	test('returns the access token and selected model for an ai-enabled account', async () => {
		const store = volumeAccountsStore(volume(memStorage()))
		await store.put(chatgpt({ enabled: { ai: { model: 'gpt-x' } } }))
		expect(await resolveAi(store)).toEqual({ access: 'tok', model: 'gpt-x' })
	})

	test('falls back to a default model when none is selected', async () => {
		const store = volumeAccountsStore(volume(memStorage()))
		await store.put(chatgpt({ enabled: { ai: {} } }))
		const resolved = await resolveAi(store)
		expect(resolved?.access).toBe('tok')
		expect(resolved?.model).toBeTruthy()
	})
})
