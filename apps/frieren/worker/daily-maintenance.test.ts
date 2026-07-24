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

	it('expires the id-migration backup once past its retention window', async () => {
		const storage = memStorage()
		const vol = volume(storage)
		const enc = new TextEncoder()
		const backup = '/system/migration-backups/app-ids-v1'
		await vol.mkdir(`${backup}/applications`, { recursive: true })
		await vol.writeFile(`${backup}/applications/x`, enc.encode('bytes'))
		// Stamped long ago -> well past the 30-day window.
		await vol.writeFile(`${backup}/.created-at`, enc.encode('0'))

		await runDailyMaintenance(storage, vol)

		expect(await vol.exists(backup)).toBe(false)
	})
})
