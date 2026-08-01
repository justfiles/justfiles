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
})
