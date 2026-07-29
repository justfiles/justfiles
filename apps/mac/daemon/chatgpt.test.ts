import { memStorage, type Volume, volume } from '@justfiles/fs'
import { describe, expect, test } from 'vitest'
import { codexModels, resolveAgentBackend } from './chatgpt.ts'

// `resolveAgentBackend` borrows the active-AI account from the Volume-backed stores
// (internal to @justfiles/app) and mints a token-sealed backend. We seed the way those
// stores persist — one JSON file per account under /host/accounts, plus the
// /system/active-ai.json selection — and drive resolution against a real in-memory
// Volume. `ai` toggles whether this account is the active AI.

const ID = 'u@openai.com'

async function seed(
	opts: { ai?: boolean; access?: string; model?: string; expires?: number } = {}
): Promise<Volume> {
	const fs = volume(memStorage())
	const enc = new TextEncoder()
	await fs.mkdir('/host/accounts', { recursive: true })
	await fs.mkdir('/system', { recursive: true })
	await fs.writeFile(
		`/host/accounts/${encodeURIComponent(ID)}.json`,
		enc.encode(
			JSON.stringify({
				id: ID,
				provider: 'chatgpt',
				creds: {
					access: opts.access ?? 'tok',
					refresh: 'ref',
					expires: opts.expires ?? Date.now() + 3_600_000,
					accountId: ID
				}
			})
		)
	)
	if (opts.ai) {
		await fs.writeFile(
			'/system/active-ai.json',
			enc.encode(
				JSON.stringify(
					opts.model !== undefined ? { accountId: ID, model: opts.model } : { accountId: ID }
				)
			)
		)
	}
	return fs
}

describe('resolveAgentBackend', () => {
	test('returns null when no connection is the active AI', async () => {
		expect(await resolveAgentBackend(await seed())).toBeNull()
	})

	test('mints a backend (real model + stream/complete fns) and seals the token', async () => {
		const backend = await resolveAgentBackend(await seed({ ai: true, access: 'SEALED-TOKEN-XYZ' }))
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
		const backend = await resolveAgentBackend(await seed({ ai: true, model: id }))
		expect(backend?.model.id).toBe(id)
	})

	test('rotates the cache revision when the credential is replaced', async () => {
		// A re-sign-in persists a fresh grant with a new expiry; the revision must change so
		// the session rebuilds instead of reusing a runtime bound to the replaced credentials.
		const first = await resolveAgentBackend(await seed({ ai: true, expires: 1_000 }))
		const replaced = await resolveAgentBackend(await seed({ ai: true, expires: 2_000 }))
		expect(first?.revision).not.toBe(replaced?.revision)
		// The same grant keeps the same revision, so an unchanged credential never rebuilds.
		const same = await resolveAgentBackend(await seed({ ai: true, expires: 1_000 }))
		expect(first?.revision).toBe(same?.revision)
	})
})
