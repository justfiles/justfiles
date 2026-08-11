import { memStorage, volume } from '@justfiles/fs'
import type { Storage } from '@justfiles/fs/storage'
import { journaledChangeSource } from '@justfiles/fs/sync-replica'
import { describe, expect, it, vi } from 'vitest'
import { runDailyMaintenance } from './daily-maintenance'

// The Durable Object storage slice the routine drives, as a fake.
function alarmState(initial?: Record<string, boolean>) {
	const kv = new Map<string, boolean>(Object.entries(initial ?? {}))
	return {
		kv,
		alarms: [] as number[],
		async get<T>(key: string) {
			return kv.get(key) as T | undefined
		},
		async put(key: string, value: boolean) {
			kv.set(key, value)
		},
		async delete(key: string) {
			return kv.delete(key)
		},
		async setAlarm(at: number) {
			this.alarms.push(at)
		}
	}
}

/** A storage whose sweep reports a bounded prune that has not drained. */
function sweepsPartially(): Storage {
	const base = memStorage()
	return {
		...base,
		caps: {
			...base.caps,
			content: {
				...base.caps?.content,
				gcUnreferenced: vi.fn(async () => ({ reclaimed: 0, done: false }))
			}
		}
	} as Storage
}

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
		await runDailyMaintenance(storage, vol, alarmState())
		const delta = await journaledChangeSource(storage.sync).pathDeltas('', { limit: 1 })

		expect(await content.hasByHash(oldHash)).toBe(false)
		expect(await content.hasByHash(currentHash)).toBe(true)
		expect(delta.changes).toHaveLength(1)
		const [change] = delta.changes
		if (change?.kind !== 'put') throw new Error('compacted delta is not a put')
		expect(change.contentHash).toBe(currentHash)
	})

	it('leaves no alarm behind when the sweep drains', async () => {
		const storage = memStorage()
		const state = alarmState()

		expect(await runDailyMaintenance(storage, volume(storage), state)).toEqual({ daily: true })

		expect(state.alarms).toEqual([])
		expect(state.kv.size).toBe(0)
	})

	it('re-arms itself while the sweep has work left', async () => {
		const storage = sweepsPartially()
		const state = alarmState()

		// The first wake is the daily one, and it asks to be woken again.
		expect(await runDailyMaintenance(storage, volume(storage), state, 1_000)).toEqual({
			daily: true
		})
		expect(state.alarms).toEqual([61_000])

		// The wake it asked for is a CONTINUATION: the sweep resumes, the daily half
		// (the agent's memory consolidation) does not.
		expect(await runDailyMaintenance(storage, volume(storage), state, 2_000)).toEqual({
			daily: false
		})
		expect(state.alarms).toEqual([61_000, 62_000])
	})

	it('stops resuming once the sweep drains, and forgets it was resuming', async () => {
		const storage = memStorage()
		const state = alarmState({ 'fs:sweep:resume': true })

		expect(await runDailyMaintenance(storage, volume(storage), state)).toEqual({ daily: false })

		expect(state.alarms).toEqual([])
		expect(state.kv.size).toBe(0)
	})
})
