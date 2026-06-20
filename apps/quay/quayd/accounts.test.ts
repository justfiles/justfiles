import type { Account } from '@justfiles/app/capabilities/accounts/host'
import { memStorage, volume } from '@justfiles/fs'
import { getModels } from '@mariozechner/pi-ai'
import { describe, expect, test } from 'vitest'
import { volumeAccountsStore } from './accounts.ts'
import { resolveAgentBackend } from './chatgpt.ts'

// quay's accounts store rides the Volume (one JSON file per account) and the
// agent's `resolveAgentBackend` mints a backend for the ai-enabled ChatGPT account
// straight from it. Both are exercised against a real in-memory Volume.

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

// The store's own unit tests now live with the canonical store in @justfiles/app
// (`capabilities/accounts/store.test.ts`); here it's just the fixture for the agent
// backend.

describe('resolveAgentBackend', () => {
	test('returns null when no ChatGPT account has ai enabled', async () => {
		const store = volumeAccountsStore(volume(memStorage()))
		await store.put(chatgpt()) // connected but ai not enabled
		expect(await resolveAgentBackend(store)).toBeNull()
	})

	test('mints a backend (real model + stream/complete fns) and seals the token', async () => {
		const store = volumeAccountsStore(volume(memStorage()))
		const account = chatgpt({ enabled: { ai: {} } })
		;(account.creds as { access: string }).access = 'SEALED-TOKEN-XYZ'
		await store.put(account)
		const backend = await resolveAgentBackend(store)
		expect(backend).not.toBeNull()
		// a real codex model, defaulted since none was selected
		expect(getModels('openai-codex').some((m) => m.id === backend?.model.id)).toBe(true)
		expect(typeof backend?.streamFn).toBe('function')
		expect(typeof backend?.completeFn).toBe('function')
		// the seam's whole point: the token rides inside the closures, never on the
		// backend object the agent receives
		expect(backend).not.toHaveProperty('apiKey')
		expect(JSON.stringify(backend)).not.toContain('SEALED-TOKEN-XYZ')
	})

	test('honours the selected model', async () => {
		const id = getModels('openai-codex')[0]?.id
		const store = volumeAccountsStore(volume(memStorage()))
		await store.put(chatgpt({ enabled: { ai: { model: id } } }))
		expect((await resolveAgentBackend(store))?.model.id).toBe(id)
	})
})
