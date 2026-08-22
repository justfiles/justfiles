import { type Volume, volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { type Cursor, type Store, sha256Hex } from '@justfiles/fs/store'
import { expect, test } from 'vitest'
import { stateStore } from './kernel.state.ts'

const fresh = () => volume(memStore())
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const caughtUp = async (store: Store): Promise<Cursor | undefined> => (await store.since()).next
const offered = async (store: Store, at: Cursor | undefined): Promise<number> =>
	(await store.since(at)).nodes.length

test('read returns an absent snapshot and seq 0 before a commit', async () => {
	const state = stateStore(fresh())
	expect(await state.read('a')).toEqual({ value: undefined, hash: null })
	expect(state.seq('a')).toBe(0)
})

test('commit writes through and bumps the local sequence', async () => {
	const fs = fresh()
	const state = stateStore(fs)
	const first = await state.commit('a', null, { n: 1 })
	const snapshot = await state.read('a')
	const second = await state.commit('a', snapshot.hash, { n: 2 })

	expect(first).toEqual({ seq: 1, changed: true })
	expect(second).toEqual({ seq: 2, changed: true })
	expect(await state.read('a')).toEqual({ value: { n: 2 }, hash: await sha256Hex(bytes({ n: 2 })) })
})

test('each read sees an external write without invalidation', async () => {
	const fs = fresh()
	const state = stateStore(fs)
	await state.commit('a', null, { n: 1 })
	await fs.writeFile('/state/a.json', bytes({ n: 99 }))

	expect((await state.read('a')).value).toEqual({ n: 99 })
})

test('a commit with a stale snapshot does not overwrite newer state', async () => {
	const fs = fresh()
	const state = stateStore(fs)
	await state.commit('a', null, { n: 1 })
	const stale = await state.read('a')
	await fs.writeFile('/state/a.json', bytes({ n: 2 }))

	expect(await state.commit('a', stale.hash, { n: 3 })).toBeNull()
	expect((await state.read('a')).value).toEqual({ n: 2 })
})

test('committing the same bytes does not write or bump the sequence', async () => {
	const store = memStore()
	const state = stateStore(volume(store))
	await state.commit('a', null, { n: 1 })
	const at = await caughtUp(store)
	const snapshot = await state.read('a')

	expect(await state.commit('a', snapshot.hash, { n: 1 })).toEqual({ seq: 1, changed: false })
	expect(await offered(store, at)).toBe(0)
})

test('sequence numbers are local and per app', async () => {
	const state = stateStore(fresh())
	await state.commit('a', null, { n: 1 })
	await state.commit('b', null, { n: 1 })
	const a = await state.read('a')
	await state.commit('a', a.hash, { n: 2 })

	expect(state.seq('a')).toBe(2)
	expect(state.seq('b')).toBe(1)
})

test('a failed state read is not hidden', async () => {
	const fs = fresh()
	await fs.mkdir('/state', { recursive: true })
	await fs.writeFile('/state/a.json', bytes({ n: 7 }))
	let offline = true
	const flaky: Volume = {
		...fs,
		async readFile(path) {
			if (offline) {
				offline = false
				throw new Error('offline')
			}
			return fs.readFile(path)
		}
	}
	const state = stateStore(flaky)

	await expect(state.read('a')).rejects.toThrow('offline')
	expect((await state.read('a')).value).toEqual({ n: 7 })
})

test('state reads do not rely on exists', async () => {
	const fs = fresh()
	await fs.mkdir('/state', { recursive: true })
	await fs.writeFile('/state/a.json', bytes({ n: 7 }))
	const noLookup: Volume = { ...fs, exists: async () => false }

	expect((await stateStore(noLookup).read('a')).value).toEqual({ n: 7 })
})

test('drop removes persisted state', async () => {
	const fs = fresh()
	const state = stateStore(fs)
	await state.commit('a', null, { n: 1 })
	await state.drop('a')

	expect(await state.read('a')).toEqual({ value: undefined, hash: null })
})
