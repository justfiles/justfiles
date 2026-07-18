import { memStorage, type Volume, volume } from '@justfiles/fs'
import { describe, expect, test } from 'vitest'
import { codexModels, resolveAgentBackend } from './chatgpt.ts'

// `resolveAgentBackend` borrows the ai-enabled account from the Volume-backed store
// (internal to @justfiles/app) and mints a token-sealed backend. We seed the account
// the way the store persists it — one JSON file per account, in the clear — and drive
// resolution against a real in-memory Volume. The account type is internal to the
// store, so we restate just the persisted fields this fixture writes.
interface SeedAccount {
	accountId: string
	providerId: string
	creds: Record<string, unknown>
	enabled: Record<string, unknown>
}

const chatgpt = (over: Partial<SeedAccount> = {}): SeedAccount => ({
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

async function seed(account: SeedAccount): Promise<Volume> {
	const fs = volume(memStorage())
	await fs.mkdir('/system/accounts', { recursive: true })
	await fs.writeFile(
		`/system/accounts/${encodeURIComponent(account.accountId)}.json`,
		new TextEncoder().encode(JSON.stringify(account))
	)
	return fs
}

describe('resolveAgentBackend', () => {
	test('returns null when no ChatGPT account has ai enabled', async () => {
		expect(await resolveAgentBackend(await seed(chatgpt()))).toBeNull()
	})

	test('mints a backend (real model + stream/complete fns) and seals the token', async () => {
		const account = chatgpt({ enabled: { ai: {} } })
		;(account.creds as { access: string }).access = 'SEALED-TOKEN-XYZ'
		const backend = await resolveAgentBackend(await seed(account))
		expect(backend).not.toBeNull()
		// a real codex model, defaulted since none was selected
		expect(codexModels().some((m) => m.id === backend?.model.id)).toBe(true)
		expect(typeof backend?.streamFn).toBe('function')
		expect(typeof backend?.completeFn).toBe('function')
		// the seam's whole point: the token rides inside the closures, never on the
		// backend object the agent receives
		expect(backend).not.toHaveProperty('apiKey')
		expect(JSON.stringify(backend)).not.toContain('SEALED-TOKEN-XYZ')
	})

	test('honours the selected model', async () => {
		const id = codexModels()[0]?.id
		const backend = await resolveAgentBackend(
			await seed(chatgpt({ enabled: { ai: { model: id } } }))
		)
		expect(backend?.model.id).toBe(id)
	})
})
