import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import type { Store } from '@justfiles/fs/store'
import { describe, expect, it, vi } from 'vitest'
import { runDailyMaintenance, sweepActivityDetails } from './daily-maintenance'

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

/** A store whose sweep drained: nothing left to come back for. */
const sweptClean = (): Store => ({
	...memStore(),
	gc: vi.fn(async () => ({ reclaimed: 3, done: true }))
})

/** A store whose sweep reports a bounded pass that has not drained. */
const sweepsPartially = (): Store => ({
	...memStore(),
	gc: vi.fn(async () => ({ reclaimed: 0, done: false }))
})

/**
 * A store with no sweep at all. `memStore` IS one — `gc` is optional (rule 8), and an
 * in-memory replica has nothing to reclaim that outliving the process does not.
 */
const cannotSweep = memStore

describe('daily maintenance', () => {
	it('sweeps every store the host holds, not only the synced one', async () => {
		const tree = sweepsPartially()
		const local = sweepsPartially()

		await runDailyMaintenance([tree, local], volume(memStore()), alarmState())

		// The app cache and the credentials live behind `/private`, in a store of their
		// own — its garbage is nobody else's sweep.
		expect(tree.gc).toHaveBeenCalledTimes(1)
		expect(local.gc).toHaveBeenCalledTimes(1)
	})

	it('leaves no alarm behind when the sweep drains', async () => {
		const store = sweptClean()
		const state = alarmState()

		expect(await runDailyMaintenance([store], volume(store), state)).toEqual({ daily: true })

		expect(state.alarms).toEqual([])
		expect(state.kv.size).toBe(0)
	})

	it('re-arms itself while the sweep has work left', async () => {
		const store = sweepsPartially()
		const state = alarmState()

		// The first wake is the daily one, and it asks to be woken again.
		expect(await runDailyMaintenance([store], volume(store), state, 1_000)).toEqual({
			daily: true
		})
		expect(state.alarms).toEqual([61_000])

		// The wake it asked for is a CONTINUATION: the sweep resumes, the daily half
		// (the agent's memory consolidation) does not.
		expect(await runDailyMaintenance([store], volume(store), state, 2_000)).toEqual({
			daily: false
		})
		expect(state.alarms).toEqual([61_000, 62_000])
	})

	it('stops resuming once the sweep drains, and forgets it was resuming', async () => {
		const store = sweptClean()
		const state = alarmState({ 'fs:sweep:resume': true })

		expect(await runDailyMaintenance([store], volume(store), state)).toEqual({
			daily: false
		})

		expect(state.alarms).toEqual([])
		expect(state.kv.size).toBe(0)
	})

	it('a store that cannot sweep asks for nothing back', async () => {
		const store = cannotSweep()
		const state = alarmState()

		expect(await runDailyMaintenance([store], volume(store), state)).toEqual({ daily: true })
		expect(state.alarms).toEqual([])
	})
})

describe('activity detail retention', () => {
	it('deletes detail older than the age limit across agent directories', async () => {
		const vol = volume(memStore())
		await detail(vol, '/private/cache/agent-activity/main/session/old.json', 'old', 8_999)
		await detail(vol, '/private/cache/agent-activity/app%2Fnotes/session/edge.json', 'edge', 9_000)
		await detail(vol, '/private/cache/agent-activity/main/session/fresh.json', 'fresh', 9_001)

		await sweepActivityDetails(vol, 10_000, { ttlMs: 1_000, storeLimit: 1_000 })

		expect(await vol.exists('/private/cache/agent-activity/main/session/old.json')).toBe(false)
		expect(await vol.exists('/private/cache/agent-activity/app%2Fnotes/session/edge.json')).toBe(
			true
		)
		expect(await vol.exists('/private/cache/agent-activity/main/session/fresh.json')).toBe(true)
	})

	it('deletes the oldest remaining files until the cache fits', async () => {
		const vol = volume(memStore())
		await detail(vol, '/private/cache/agent-activity/main/session/first.json', '111', 1)
		await detail(vol, '/private/cache/agent-activity/main/session/second.json', '222', 2)
		await detail(vol, '/private/cache/agent-activity/main/session/third.json', '333', 3)

		await sweepActivityDetails(vol, 10_000, { ttlMs: 20_000, storeLimit: 4 })

		expect(await vol.exists('/private/cache/agent-activity/main/session/first.json')).toBe(false)
		expect(await vol.exists('/private/cache/agent-activity/main/session/second.json')).toBe(false)
		expect(await vol.exists('/private/cache/agent-activity/main/session/third.json')).toBe(true)
	})
})

async function detail(
	vol: ReturnType<typeof volume>,
	path: string,
	content: string,
	mtimeMs: number
) {
	await vol.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
	await vol.writeFile(path, new TextEncoder().encode(content))
	await vol.utimes(path, BigInt(mtimeMs) * 1_000_000n)
}
