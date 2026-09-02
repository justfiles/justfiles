/**
 * The two things this runtime cannot get wrong on the boot that matters.
 *
 * It scans the tree ONCE in `createVolumeRuntime` and then serves that listing from
 * memory until something asks for a refresh — and the only thing that does is a window
 * focus. So a boot that records "loaded" before the first sync ran shows an empty
 * workspace on a fresh device until the user happens to click away and back. That is what
 * `localFirst` would buy, and it is why this runtime does not pass it.
 *
 * And the boot that runs the one pass out of the old model runs it once per origin, not
 * once per tab.
 */

import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { receiver } from '@justfiles/fs/peer'
import { beforeEach, expect, test, vi } from 'vitest'

// The pass itself has its own tests (`migrate.idb.test.ts`); what matters here is how
// many times this host runs it. `adoptOnce` is NOT mocked — it is the thing under test.
vi.mock('@justfiles/fs/migrate.idb', async (original) => ({
	...(await original<typeof import('@justfiles/fs/migrate.idb')>()),
	migrateIdb: async () => {
		adoptions += 1
	}
}))

const peerStore = memStore()
const peer = receiver(peerStore)
let adoptions = 0

// The two stores this runtime opens by name. The local one is shared across the "tabs"
// below, because two tabs of one origin open the same database.
const tree = memStore()
vi.mock('@justfiles/fs/idb', () => ({
	idbStore: () => tree,
	sharedStore: (store: unknown) => store
}))
vi.mock('@justfiles/fs/http', () => ({ httpStore: () => peer }))

import { createVolumeRuntime } from './useVolume'

beforeEach(() => {
	adoptions = 0
	const held = new Map<string, string>()
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => held.get(key) ?? null,
		setItem: (key: string, value: string) => held.set(key, value),
		removeItem: (key: string) => held.delete(key)
	})
	// A real mutex, which is all `adoptOnce` asks of `navigator.locks`.
	let chain = Promise.resolve()
	vi.stubGlobal('navigator', {
		locks: {
			request: <T>(_name: string, fn: () => Promise<T>) => {
				const run = chain.then(fn)
				chain = run.then(
					() => {},
					() => {}
				)
				return run
			}
		}
	})
})

test('the boot listing already holds what only the peer had', async () => {
	await volume(peerStore).writeFile('/from-another-device.md', new TextEncoder().encode('# hi'))

	const runtime = await createVolumeRuntime(async () => 'token')

	expect(runtime.getSnapshot().entries.map((entry) => entry.path)).toEqual([
		'from-another-device.md'
	])
})

// Two tabs opened on the same upgrade both read "not adopted" unless the marker check is
// inside the lock. `migrate` commits WITHOUT guards, so a second pass would write the old
// tree over rows the first tab's volume had already pulled.
test('two tabs racing the upgrade adopt the old database once', async () => {
	await Promise.all([
		createVolumeRuntime(async () => 'token'),
		createVolumeRuntime(async () => 'token')
	])

	expect(adoptions).toBe(1)
})
