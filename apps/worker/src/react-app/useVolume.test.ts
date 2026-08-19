/**
 * The one thing this runtime cannot get wrong: the listing it takes at boot.
 *
 * It scans the tree ONCE and then serves that listing from memory until something asks
 * for a refresh — and the only thing that does is a window focus. So a boot that records
 * "loaded" before the first sync ran shows an empty workspace on a fresh device until the
 * user happens to click away and back. That is what `localFirst` would buy, and it is why
 * this runtime does not pass it.
 */

import { memStore } from '@justfiles/fs/store.mem'
import { storeVolume } from '@justfiles/fs/volume.store'
import { beforeEach, expect, test, vi } from 'vitest'

const peer = memStore()

// The two stores this runtime opens by name. The local one is fresh per test; the peer
// stands in for the server and keeps the note written below.
vi.mock('@justfiles/fs/store.idb', () => ({
	idbStore: () => memStore(),
	sharedStore: (store: unknown) => store
}))
vi.mock('@justfiles/fs/store.http', () => ({ httpStore: () => peer }))
// The one pass out of the old model has its own tests; here there is nothing to adopt.
vi.mock('@justfiles/fs/migrate.idb', () => ({ migrateIdb: async () => {} }))

import { createVolumeRuntime } from './useVolume'

beforeEach(() => {
	const held = new Map<string, string>()
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => held.get(key) ?? null,
		setItem: (key: string, value: string) => held.set(key, value),
		removeItem: (key: string) => held.delete(key)
	})
})

test('the boot listing already holds what only the peer had', async () => {
	await storeVolume(peer).writeFile('/from-another-device.md', new TextEncoder().encode('# hi'))

	const runtime = await createVolumeRuntime(async () => 'token')

	expect(runtime.getSnapshot().entries.map((entry) => entry.path)).toEqual([
		'from-another-device.md'
	])
})
