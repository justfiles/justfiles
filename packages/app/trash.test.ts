import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TRASH_RETENTION_MS, sweepTrash } from './trash.ts'

const NOW = Date.parse('2026-07-14T12:00:00Z')
const day = (offsetDays: number) =>
	new Date(NOW - offsetDays * 86_400_000).toISOString().slice(0, 10)

async function seedTrash(names: string[]) {
	const vol = volume(memStore())
	for (const name of names) {
		await vol.mkdir(`/trash/${name}/entry`, { recursive: true })
		await vol.writeFile(`/trash/${name}/entry/f`, new TextEncoder().encode('x'))
	}
	return vol
}

describe('sweepTrash', () => {
	it('drops day folders older than the retention window, keeps the rest', async () => {
		// retention = 7 days, so the cutoff day is day(7); strictly-older days go.
		const vol = await seedTrash([day(10), day(8), day(7), day(1)])
		await sweepTrash(vol, DEFAULT_TRASH_RETENTION_MS, NOW)
		const remaining = (await vol.readdir('/trash')).map((e) => e.name).sort()
		expect(remaining).toEqual([day(7), day(1)].sort())
	})

	it('leaves non-day entries untouched and no-ops when /trash is absent', async () => {
		const vol = await seedTrash([day(30), 'not-a-day'])
		await sweepTrash(vol, DEFAULT_TRASH_RETENTION_MS, NOW)
		expect((await vol.readdir('/trash')).map((e) => e.name)).toEqual(['not-a-day'])

		const empty = volume(memStore())
		await expect(sweepTrash(empty, DEFAULT_TRASH_RETENTION_MS, NOW)).resolves.toBeUndefined()
	})
})
