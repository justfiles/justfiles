import { memStorage, volume } from '@justfiles/fs'
import { describe, expect, it } from 'vitest'
import { runDailyMaintenance } from './daily-alarm'

describe('daily maintenance', () => {
	it('collects superseded content without removing the live blob', async () => {
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
		expect(await content.hasByHash(oldHash)).toBe(false)
		expect(await content.hasByHash(currentHash)).toBe(true)
	})
})
