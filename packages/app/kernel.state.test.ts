import { memStorage, volume } from '@justfiles/fs'
import { expect, test } from 'vitest'
import { stateStore } from './kernel.state.ts'

// The state store in isolation — no kernel, no sandbox, just a fs. Covers the
// in-memory/write-through cache, monotonic seq, fs hydration on boot, and drop.

const fresh = () => volume(memStorage())

test('current is undefined and seq is 0 before any commit', async () => {
	const s = stateStore(fresh())
	expect(await s.current('a')).toBeUndefined()
	expect(s.seq('a')).toBe(0)
})

test('commit writes through and bumps a monotonic seq', async () => {
	const s = stateStore(fresh())
	expect(await s.commit('a', { n: 1 })).toBe(1)
	expect(await s.commit('a', { n: 2 })).toBe(2)
	expect(s.seq('a')).toBe(2)
	expect(await s.current('a')).toEqual({ n: 2 })
})

test('a fresh store hydrates committed state from fs (boot)', async () => {
	const fs = fresh()
	await stateStore(fs).commit('a', { n: 7 })

	// New store over the same fs — in-memory caches are empty, like a DO restart.
	const rebooted = stateStore(fs)
	expect(await rebooted.current('a')).toEqual({ n: 7 })
	// seq is recomputed from zero on boot; the next commit continues from there.
	expect(rebooted.seq('a')).toBe(0)
	expect(await rebooted.commit('a', { n: 8 })).toBe(1)
})

test('state and seq are tracked per app', async () => {
	const s = stateStore(fresh())
	await s.commit('a', { v: 'a1' })
	await s.commit('b', { v: 'b1' })
	await s.commit('a', { v: 'a2' })
	expect(s.seq('a')).toBe(2)
	expect(s.seq('b')).toBe(1)
	expect(await s.current('a')).toEqual({ v: 'a2' })
	expect(await s.current('b')).toEqual({ v: 'b1' })
})

test('drop clears the persisted and in-memory state', async () => {
	const fs = fresh()
	const s = stateStore(fs)
	await s.commit('a', { n: 1 })
	await s.drop('a')
	expect(await s.current('a')).toBeUndefined()
	// Gone from fs too — a fresh store sees nothing.
	expect(await stateStore(fs).current('a')).toBeUndefined()
})

test('invalidate re-hydrates from fs on the next read (external write)', async () => {
	const fs = fresh()
	const s = stateStore(fs)
	await s.commit('a', { n: 1 })
	expect(await s.current('a')).toEqual({ n: 1 }) // cached

	// Simulate a synced-down write: the file changes UNDER the store (another writer),
	// so the in-memory cache is now stale.
	await fs.writeFile('/state/a.json', new TextEncoder().encode(JSON.stringify({ n: 99 })))
	expect(await s.current('a')).toEqual({ n: 1 }) // still the stale cache — the bug

	s.invalidate('a')
	expect(await s.current('a')).toEqual({ n: 99 }) // now reflects the file
	// seq is untouched by invalidate; the next commit still continues monotonically.
	expect(s.seq('a')).toBe(1)
	expect(await s.commit('a', { n: 100 })).toBe(2)
})
