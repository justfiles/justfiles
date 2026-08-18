/**
 * `fsStore` over a disk that is not a disk: the same store and the same contract suite,
 * with no temp directories, no timestamp granularity to work around and no OS
 * scheduling. That is what makes the conformance suite run in milliseconds against the
 * native backend, and the property tests in `store.fs.model.test.ts` possible at all.
 *
 * Not a replacement for `store.fs.test.ts`. A fake disk proves the store’s reasoning,
 * never the platform’s behaviour, so the cases that turn on what a real filesystem does
 * — a symlinked ancestor, `lutimes` precision, an unopenable directory — live there.
 */

import { describe, expect, test } from 'vitest'
import { AT_ROOT, type Disk, type Spot, stateOf, under } from './disk'
import { memDisk } from './disk.mem'
import { type Node, ROOT, type Store, sha256Hex } from './store'
import { storeConformance } from './store.conformance'
import { fsStore, SWEEP_MS } from './store.fs'

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

test('a write that carries an observation lands only while it holds', async () => {
	// The whole state and not just the inode: `echo x > f` truncates in place and keeps
	// it, so a check that only asked whose inode it was would miss the commonest edit.
	const disk = memDisk()
	const at = under(AT_ROOT, 'a.txt')
	if (at === null) throw new Error('unreachable')
	await disk.write(at, bytes('hello'))
	const s = await disk.stat(at)
	if (s === null) throw new Error('unreachable')
	const was = { path: at, ino: String(s.ino), state: stateOf(s) }

	expect(await disk.write(at, bytes('again'), undefined, was)).toBe(true)
	// And now the observation is stale, because that write moved it.
	expect(await disk.write(at, bytes('third'), undefined, was)).toBe(false)
	expect(await disk.bytes(at)).toEqual(bytes('again'))
})

describe('fsStore: a file is not a blob store', () => {
	test('bytes that moved under their key are no answer (rule 7)', async () => {
		// `fileFor` picks a file by looking at it, and the read comes after — two calls,
		// and a local tool can rewrite the file in between. What came back would go out
		// under a key that no longer names it: into another row's file as its content, or
		// to a peer.
		const disk = memDisk()
		// Armed with the one path whose read is to be raced — not the first read of any
		// path, which would land before `fileFor` looks and prove nothing.
		let meddle: Spot | null = null
		const racy: Disk = {
			...disk,
			async bytes(spot, strict) {
				if (spot === meddle) {
					meddle = null
					await disk.write(spot, bytes('goodbye'))
				}
				return disk.bytes(spot, strict)
			}
		}
		const store = fsStore('mem', racy)
		built.push(store)

		const hash = 'a'.repeat(64)
		await store.blobs.put(hash, bytes('hello'))
		await store.commit([
			{
				id: 'a',
				parent: ROOT,
				name: 'a.txt',
				type: 'file',
				mode: 0o100644,
				size: 5n,
				mtimeNs: 0n,
				content: hash,
				version: 'v1'
			}
		])
		expect(await store.blobs.get(hash)).toEqual(bytes('hello'))

		// The rewrite lands after the look that chose the file and before the read.
		const at = under(AT_ROOT, 'a.txt')
		if (at === null) throw new Error('unreachable')
		meddle = at
		expect(await store.blobs.get(hash)).toBeNull()
	})

	test('a stub a local tool wrote into is not overwritten when its content lands', async () => {
		// `hydrate` fills a placeholder whose content arrived late. If somebody typed into
		// that placeholder first, those bytes are the only copy of themselves there is —
		// the row is looked at again instead, and what the file holds becomes its content.
		const disk = memDisk()
		const store = fsStore('mem', disk)
		built.push(store)

		const hash = 'd'.repeat(64)
		await store.commit([
			{
				id: 'a',
				parent: ROOT,
				name: 'a.txt',
				type: 'file',
				mode: 0o100644,
				size: 0n,
				mtimeNs: 0n,
				content: hash,
				version: 'v1'
			}
		])
		const at = under(AT_ROOT, 'a.txt')
		if (at === null) throw new Error('unreachable')
		expect(await disk.bytes(at)).toEqual(bytes(''))

		await disk.write(at, bytes('mine, typed while waiting'))
		await store.blobs.put(hash, bytes('the content, late'))

		expect(await disk.bytes(at)).toEqual(bytes('mine, typed while waiting'))
	})
})

describe('fsStore: what a placement may claim about the file it left', () => {
	test('a hash is not recorded against a file somebody else took the name for', async () => {
		// The observation is deferred to the end of the batch, so a directory's mtime has
		// settled before it is read. That leaves a window between a file being placed and
		// being looked at, and a local tool taking the name in it would have its state
		// recorded next to the hash of the bytes the store meant to place. That pair reads
		// as already reconciled: the scan skips the edit for ever, and `blobs` answers
		// those bytes under a hash that does not name them.
		const disk = memDisk()
		let meddle: Spot | null = null
		let looks = 0
		const racy: Disk = {
			...disk,
			async stat(spot) {
				const s = await disk.stat(spot)
				// The placement's own last act is to look at what it left, so firing straight
				// after that puts the edit in the window: placed, not yet observed.
				if (spot === meddle && ++looks === 1) await disk.write(spot, bytes('typed by a local tool'))
				return s
			}
		}
		const store = fsStore('mem', racy)
		built.push(store)
		const at = under(AT_ROOT, 'a.txt')
		if (at === null) throw new Error('unreachable')

		const key = 'e'.repeat(64)
		await store.blobs.put(key, bytes('what the store meant to place'))
		meddle = at
		await store.commit([
			{
				id: 'a',
				parent: ROOT,
				name: 'a.txt',
				type: 'file',
				mode: 0o100644,
				size: 29n,
				mtimeNs: 0n,
				content: key,
				version: 'v1'
			}
		])
		meddle = null

		expect(await disk.bytes(at)).toEqual(bytes('typed by a local tool'))
		// Not answered under a key that does not name them,
		expect(await store.blobs.get(key)).not.toEqual(bytes('typed by a local tool'))
		// and not invisible to the scan either — the deep pass derives what is there.
		await new Promise((resolve) => setTimeout(resolve, SWEEP_MS * 6))
		await store.since()
		expect((await store.get('a'))?.content).toBe(await sha256Hex(bytes('typed by a local tool')))
	}, 30_000)
})

describe('fsStore: what a commit may take off the disk', () => {
	const folder = (deleted = false): Node => ({
		id: 'd',
		parent: ROOT,
		name: 'folder',
		type: 'dir',
		mode: 0o040755,
		size: 0n,
		mtimeNs: 0n,
		version: deleted ? 'v2' : 'v1',
		...(deleted ? { deleted: true } : {})
	})

	test('a file the store never saw is not taken with the directory holding it', async () => {
		// A peer deletes a folder; a local tool made a file in it since the last look. That
		// file is in nobody's index, so `holdsFiles` would call the directory empty and the
		// recursive removal would take the only copy of it there is. Looked at first, it
		// becomes a row instead — of the buried directory, so it keeps its bytes in the
		// holding area, and it goes out on the feed for every other replica.
		const disk = memDisk()
		const store = fsStore('mem', disk)
		built.push(store)
		await store.commit([folder()])
		await store.since()

		const at = under(AT_ROOT, 'folder')
		if (at === null) throw new Error('unreachable')
		const child = under(at, 'local.txt')
		if (child === null) throw new Error('unreachable')
		await disk.write(child, bytes('the only copy of this'))

		await store.commit([folder(true)])

		const hash = await sha256Hex(bytes('the only copy of this'))
		const feed = await store.since()
		expect({
			reachable: await store.blobs.has(hash),
			content: await store.blobs.get(hash),
			live: feed.nodes.filter((n) => !n.deleted && n.content === hash).map((n) => n.name)
		}).toEqual({
			reachable: true,
			content: bytes('the only copy of this'),
			live: ['local.txt']
		})
	})

	test('a directory this store cannot list is moved aside, never removed', async () => {
		// Not knowing what is under it is reason enough. A recursive removal cannot be
		// taken back, and a mode that shuts this store out hides exactly the files it
		// would be taking.
		const disk = memDisk()
		const store = fsStore('mem', disk)
		built.push(store)
		await store.commit([folder()])
		await store.since()

		const at = under(AT_ROOT, 'folder')
		if (at === null) throw new Error('unreachable')
		const child = under(at, 'local.txt')
		if (child === null) throw new Error('unreachable')
		await disk.write(child, bytes('behind a shut door'))
		await disk.stamp(at, { mode: 0o000 }) // no read, no search

		await store.commit([folder(true)])

		// Nothing is at the name any more, because the whole thing went aside intact.
		expect(await disk.stat(at)).toBeNull()
		const held = under(AT_ROOT, '.jfs')
		if (held === null) throw new Error('unreachable')
		expect(await disk.list(held)).toContain('detached')
	})
})

describe('fsStore: a file arrives already describing itself', () => {
	test('a placement needs no stamp of its own', async () => {
		// The stamp rides in with the payload, so what takes the name is already the object
		// the row describes — there is no moment where it wears `writeFile`'s mode, and
		// nothing to put on whatever answers to the name afterwards. Shown by refusing every
		// `stamp` at the path: the mode has to be right without one.
		const store = fsStore(
			'mem',
			memDisk((op, at) => (op === 'stamp' && at === 'a.txt' ? 'EPERM' : null))
		)
		built.push(store)
		const key = 'f'.repeat(64)
		await store.blobs.put(key, bytes('hello'))
		await store.commit([
			{
				id: 'a',
				parent: ROOT,
				name: 'a.txt',
				type: 'file',
				mode: 0o100600,
				size: 5n,
				mtimeNs: 1_000_000_000n,
				content: key,
				version: 'v1'
			}
		])
		const row = await store.get('a')
		expect({ mode: row?.mode, mtimeNs: row?.mtimeNs }).toEqual({
			mode: 0o100600,
			mtimeNs: 1_000_000_000n
		})
	})
})
