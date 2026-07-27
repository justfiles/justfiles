import { memStorage, volume } from '@justfiles/fs'
import { journaledChangeSource } from '@justfiles/fs/sync-replica'
import { describe, expect, it } from 'vitest'
import { runDailyMaintenance } from './daily-maintenance'

describe('daily maintenance', () => {
	it('compacts served deltas before collecting superseded content', async () => {
		const storage = memStorage()
		const vol = volume(storage)
		const content = storage.caps?.content
		if (!content) throw new Error('test storage has no content capability')

		await vol.writeFile('/state.json', new TextEncoder().encode('old'))
		const oldHash = (await vol.stat('/state.json')).contentHash!
		await vol.writeFile('/state.json', new TextEncoder().encode('current'))
		const currentHash = (await vol.stat('/state.json')).contentHash!

		expect(await content.hasByHash(oldHash)).toBe(true)
		await runDailyMaintenance(storage, vol)
		const delta = await journaledChangeSource(storage).pathDeltas('', { limit: 1 })

		expect(await content.hasByHash(oldHash)).toBe(false)
		expect(await content.hasByHash(currentHash)).toBe(true)
		expect(delta.changes).toHaveLength(1)
		const [change] = delta.changes
		if (change?.kind !== 'put') throw new Error('compacted delta is not a put')
		expect(change.contentHash).toBe(currentHash)
	})

	// Faces are named after the avatar they were derived from, so replacing the avatar
	// orphans the old set rather than overwriting it.
	it('drops per-expression faces that no longer match the avatar', async () => {
		const storage = memStorage()
		const vol = volume(storage)
		await vol.mkdir('/system/agents/main', { recursive: true })
		await vol.writeFile('/system/agents/main/avatar.png', new Uint8Array([1, 2, 3]))
		// The hash for those bytes — see avatarFaceHash (first 8 hex chars of SHA-256).
		const { avatarFaceHash } = await import('@justfiles/agent/defaults')
		const hash = await avatarFaceHash(new Uint8Array([1, 2, 3]))
		const kept = `/system/agents/main/avatar-pleased@${hash}.png`
		const stale = '/system/agents/main/avatar-pleased@deadbeef.png'
		await vol.writeFile(kept, new Uint8Array([9]))
		await vol.writeFile(stale, new Uint8Array([9]))

		await runDailyMaintenance(storage, vol)

		expect(await vol.exists(kept)).toBe(true)
		expect(await vol.exists(stale)).toBe(false)
		expect(await vol.exists('/system/agents/main/avatar.png')).toBe(true)
	})
})
