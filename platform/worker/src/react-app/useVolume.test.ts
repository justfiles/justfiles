/**
 * The two things this runtime cannot get wrong on the boot that matters.
 *
 * It scans the tree ONCE in `createVolumeRuntime` and then serves that listing from
 * memory until something asks for a refresh — and the only thing that does is a window
 * focus. So a boot that records "loaded" before the first sync ran shows an empty
 * workspace on a fresh device until the user happens to click away and back. That is what
 * `localFirst` would buy, and it is why this runtime does not pass it.
 *
 * Legacy databases are intentionally left alone: this version starts from a new store
 * namespace and performs a full remote bootstrap.
 */

import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { receiver } from '@justfiles/fs/peer'
import { beforeEach, expect, test, vi } from 'vitest'

const peerStore = memStore()
const peer = receiver(peerStore)

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
	const held = new Map<string, string>()
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => held.get(key) ?? null,
		setItem: (key: string, value: string) => held.set(key, value),
		removeItem: (key: string) => held.delete(key)
	})
})

test('the boot listing already holds what only the peer had', async () => {
	await volume(peerStore).writeFile('/from-another-device.md', new TextEncoder().encode('# hi'))

	const runtime = await createVolumeRuntime(async () => 'token')

	expect(runtime.getSnapshot().entries.map((entry) => entry.path)).toEqual([
		'from-another-device.md'
	])
})
