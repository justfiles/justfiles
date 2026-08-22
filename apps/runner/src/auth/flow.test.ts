import { expect, test } from 'vitest'
import { beginFlow, takeFlow } from './flow'
import { hashSecret } from './secret'
import { testDatabase } from './test-db'

const FLOW_LIFE_MS = 10 * 60 * 1000

test('stores hashes and consumes a bound flow once', async () => {
	const { database, sqlite } = testDatabase()
	const flow = await beginFlow(database, 'alice.notes', 1_000)
	const stored = sqlite
		.prepare('SELECT state_hash, browser_hash, expires_at FROM oauth_flows')
		.get() as { state_hash: string; browser_hash: string; expires_at: number }

	expect(flow.state).toHaveLength(43)
	expect(flow.browser).toHaveLength(43)
	expect(flow.challenge).toHaveLength(43)
	expect(stored.state_hash).not.toBe(flow.state)
	expect(stored.browser_hash).not.toBe(flow.browser)
	expect(stored.expires_at).toBe(1_000 + FLOW_LIFE_MS)
	expect(await takeFlow(database, flow.state, 'wrong-browser', 1_001)).toBeNull()
	const taken = await takeFlow(database, flow.state, flow.browser, 1_001)
	expect(taken).toMatchObject({
		appId: 'alice.notes',
		nonce: flow.nonce
	})
	expect(await hashSecret(taken?.verifier ?? '')).toBe(flow.challenge)
	expect(await takeFlow(database, flow.state, flow.browser, 1_001)).toBeNull()
})

test('does not consume or return an expired flow', async () => {
	const { database } = testDatabase()
	const flow = await beginFlow(database, 'alice.notes', 1_000)

	expect(await takeFlow(database, flow.state, flow.browser, 1_000 + FLOW_LIFE_MS)).toBeNull()
})
