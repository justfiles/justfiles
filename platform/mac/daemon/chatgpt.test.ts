import { hostAccounts } from '@justfiles/app/capabilities/accounts/host'
import { type Volume, volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { describe, expect, test } from 'vitest'
import { chatgptProvider, codexBackend, codexModels } from './chatgpt.ts'

// `codexBackend` is minted from the account module's lease and never sees the store. We
// seed the way that store persists — one JSON file per account under /private/accounts,
// plus the /private/active-ai.json selection — and drive resolution against a real
// in-memory Volume. `ai` toggles whether this account is the active AI. The daemon offers
// no builtin AI provider, so nothing selected means no backend at all.
const resolve = (fs: Volume) => hostAccounts([chatgptProvider()], fs).resolveAi(codexBackend)

const ID = 'u@openai.com'

async function seed(
	opts: { ai?: boolean; access?: string; model?: string; expires?: number } = {}
): Promise<Volume> {
	const fs = volume(memStore())
	const enc = new TextEncoder()
	await fs.mkdir('/private/accounts', { recursive: true })
	await fs.mkdir('/system', { recursive: true })
	await fs.writeFile(
		`/private/accounts/${encodeURIComponent(ID)}.json`,
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
			'/private/active-ai.json',
			enc.encode(
				JSON.stringify(
					opts.model !== undefined ? { accountId: ID, model: opts.model } : { accountId: ID }
				)
			)
		)
	}
	return fs
}

describe('the daemon agent backend', () => {
	test('returns null when no connection is the active AI', async () => {
		expect(await resolve(await seed())).toBeNull()
	})

	test('mints a backend (real model + stream/complete fns) and seals the token', async () => {
		const backend = await resolve(await seed({ ai: true, access: 'SEALED-TOKEN-XYZ' }))
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
		const backend = await resolve(await seed({ ai: true, model: id }))
		expect(backend?.model.id).toBe(id)
	})

	test('rotates the cache revision when the credential is replaced', async () => {
		// A re-sign-in persists a fresh grant with a new expiry; the revision must change so
		// the session rebuilds instead of reusing a runtime bound to the replaced credentials.
		const first = await resolve(await seed({ ai: true, expires: 1_000 }))
		const replaced = await resolve(await seed({ ai: true, expires: 2_000 }))
		expect(first?.revision).not.toBe(replaced?.revision)
		// The same grant keeps the same revision, so an unchanged credential never rebuilds.
		const same = await resolve(await seed({ ai: true, expires: 1_000 }))
		expect(first?.revision).toBe(same?.revision)
	})
})
