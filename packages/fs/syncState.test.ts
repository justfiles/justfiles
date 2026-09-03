import { describe, expect, it } from 'vitest'
import { memStore } from './mem'
import { ROOT } from './store'
import { privateSyncState, syncStateLock } from './syncState'
import { announceMount, volume } from './volume'

describe('private sync state', () => {
	it('keeps identity separate from mutable state and outside the shared feed', async () => {
		const shared = memStore()
		const local = memStore()
		await announceMount(shared, ROOT, 'private')
		const vol = volume(shared, { bindings: new Map([[ROOT, new Map([['private', local]])]]) })
		const state = privateSyncState(vol)

		const id = await state.peerId()
		const pull = state.cursor('pull')
		await pull.save('cursor')
		await pull.identify('remote')
		await state.discard.save(true)

		expect(await state.peerId()).toBe(id)
		expect(await state.cursor('pull').load()).toBe('cursor')
		expect(await state.remoteId.load()).toBe('remote')
		expect(await state.discard.load()).toBe(true)
		expect(await vol.readFile('/private/state/clientid')).toEqual(
			new TextEncoder().encode(JSON.stringify(id))
		)
		const feed = await shared.since()
		expect(feed.nodes.map((row) => row.name)).not.toContain('state')
	})

	it('merges a tab update with the latest shared relationship state', async () => {
		const backing = memStore()
		const first = privateSyncState(volume(backing))
		const second = privateSyncState(volume(backing))
		const lock = syncStateLock()

		await lock(() => second.cursor('push').load())
		await lock(() => first.discard.save(true))
		await lock(() => second.cursor('push').save('push'))

		const saved = privateSyncState(volume(backing))
		expect(await saved.discard.load()).toBe(true)
		expect(await saved.cursor('push').load()).toBe('push')
	})
})
