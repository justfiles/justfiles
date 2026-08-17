/**
 * `fsStore` over a disk that is not a disk.
 *
 * The same store, the same contract suite, and none of the cost: no temp
 * directories, no timestamp granularity to work around, no OS scheduling. What
 * that buys is the two things this file is really for — the conformance suite
 * running against the native backend in milliseconds, and the property tests in
 * `store.fs.model.test.ts` being possible at all.
 *
 * It is not a replacement for `store.fs.test.ts`. A fake disk proves the store's
 * reasoning, never the platform's behaviour, and the cases that turn on what a
 * real filesystem does — a symlinked ancestor, `lutimes` precision, an
 * unopenable directory — live over there and stay there.
 */

import { describe, expect, test } from 'vitest'
import { AT_ROOT, under } from './disk'
import { memDisk } from './disk.mem'
import { ROOT, type Store } from './store'
import { storeConformance } from './store.conformance'
import { fsStore } from './store.fs'

const built: Store[] = []
const open = (fault?: Parameters<typeof memDisk>[0]): Store => {
	const store = fsStore('mem', memDisk(fault))
	built.push(store)
	return store
}

storeConformance('fsStore over memDisk', async () => open())

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)

describe('memDisk: the rules that made the findings', () => {
	test('a directory that grants no read is not a directory with no entries', async () => {
		// The distinction the whole scan turns on. A `list` that cannot look answers
		// null, and null is not the empty array — a store that confused the two would
		// tombstone every row under a directory somebody chmod'd.
		const disk = memDisk()
		const dir = under(AT_ROOT, 'shut')
		if (dir === null) throw new Error('unreachable')
		await disk.dir(dir)
		const file = under(dir, 'a.txt')
		if (file === null) throw new Error('unreachable')
		await disk.write(file, bytes('hello'))

		expect(await disk.list(dir)).toEqual(['a.txt'])
		await disk.stamp(dir, { mode: 0o300 }) // write and search, but no read
		expect(await disk.list(dir)).toBeNull()
		// And what is under it is still reachable, because search is still granted.
		expect(await disk.stat(file)).not.toBeNull()

		await disk.stamp(dir, { mode: 0o600 }) // read and write, but no search
		expect(await disk.stat(file)).toBeNull()
	})

	test('a rename carries the inode, and a publish mints a new one', async () => {
		// Identity is the inode, so the fake has to be as careful with them as the
		// real one: a test that let a rewritten file keep its inode would never
		// exercise the checks that exist because it does not.
		const disk = memDisk()
		const a = under(AT_ROOT, 'a.txt')
		const b = under(AT_ROOT, 'b.txt')
		if (a === null || b === null) throw new Error('unreachable')

		await disk.write(a, bytes('one'))
		const first = await disk.stat(a)
		if (first === null) throw new Error('unreachable')

		await disk.write(a, bytes('two'))
		const second = await disk.stat(a)
		expect(second?.ino).not.toBe(first.ino)

		const at = { path: a, ino: String(second?.ino), state: '' }
		expect(await disk.move(at, b)).toBe(true)
		expect((await disk.stat(b))?.ino).toBe(second?.ino)
		expect(await disk.stat(a)).toBeNull()
	})

	test('a stamp writes the millisecond a Date carries, and no finer', async () => {
		// The real backend can only write what a `Date` holds, and the store forgives
		// the difference (`rounded`). If the fake stored the nanoseconds it was given,
		// that forgiveness would never be exercised and the case would rot.
		const disk = memDisk()
		const a = under(AT_ROOT, 'a.txt')
		if (a === null) throw new Error('unreachable')
		await disk.write(a, bytes('hello'))

		await disk.stamp(a, { mode: 0o644, mtimeNs: 1_234_567_891_234_567n })
		expect((await disk.stat(a))?.mtimeNs).toBe(1_234_567_891_000_000n)
	})
})

describe('fsStore over memDisk: a fault is not a lie', () => {
	test('an index it cannot read is never taken for a tree with no history', async () => {
		// Rule 11 and the worst failure this backend has: reading the sidecar as
		// absent mints a new lineage, rebinds every id, and then saves over the index
		// that could have said otherwise.
		const disk = memDisk((op, at) => (op === 'read' && at.endsWith('index.json') ? 'EACCES' : null))
		const store = fsStore('mem', disk)
		await expect(store.get(ROOT)).rejects.toThrow(/EACCES/)
	})
})
