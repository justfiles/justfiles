/**
 * `fsStore` over a disk that is not a disk: the same store and the same contract suite,
 * with no temp directories, no timestamp granularity to work around and no OS
 * scheduling. That is what makes the conformance suite run in milliseconds against the
 * native backend, and the property tests in `fs.model.test.ts` possible at all.
 *
 * Not a replacement for `fs.test.ts`. A fake disk proves the store’s reasoning,
 * never the platform’s behaviour, so the cases that turn on what a real filesystem does
 * — a symlinked ancestor, `lutimes` precision, an unopenable directory — live there.
 */

import { afterEach, describe, expect, test, vi } from 'vitest'
import { storeConformance } from './conformance'
import { AT_ROOT, type Disk, type Spot, stateOf, under } from './disk'
import { memDisk } from './disk.mem'
import { authorOf } from './engine'
import { fsStore, SWEEP_MS } from './fs'
import { type Node, ROOT, type Store, sha256Hex } from './store'

const built: Store[] = []
const open = (fault?: Parameters<typeof memDisk>[0]): Store => {
	const store = fsStore('mem', { disk: memDisk(fault) })
	built.push(store)
	return store
}
afterEach(async () => {
	for (const store of built.splice(0)) await store.close?.()
})

storeConformance('fsStore over memDisk', async () => open())

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)

describe('fsStore subscriptions', () => {
	const row = (id: string, name: string): Node => ({
		id,
		parent: ROOT,
		name,
		type: 'file',
		mode: 0o100644,
		mtimeNs: 0n,
		size: 0n,
		version: `test:${id}`
	})

	test('an internal commit publishes only after the sidecar is saved', async () => {
		const disk = memDisk()
		const store = fsStore('mem', { disk })
		built.push(store)
		await store.since()
		const side = under(AT_ROOT, '.jfs')
		const index = side === null ? null : under(side, 'index.json')
		if (index === null) throw new Error('invalid sidecar path')

		const delivered = new Promise<Node[]>((resolve) => {
			store.subscribe?.((rows) => {
				void disk.bytes(index, true).then((saved) => {
					expect(new TextDecoder().decode(saved ?? new Uint8Array())).toContain('"id":"a"')
					resolve(rows)
				})
			})
		})
		await store.commit([row('a', 'a.txt')])
		expect((await delivered).map((node) => node.id)).toEqual(['a'])
	})

	test('a failed commit does not publish', async () => {
		let fail = false
		const disk = memDisk((op, at) =>
			fail && op === 'write' && at.endsWith('index.json') ? 'EIO' : null
		)
		const store = fsStore('mem', { disk })
		built.push(store)
		await store.since()
		let calls = 0
		store.subscribe?.(() => calls++)

		fail = true
		await expect(store.commit([row('a', 'a.txt')])).rejects.toThrow('EIO')
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(calls).toBe(0)
	})

	test('a sidecar save retry publishes the rows from the failed turn', async () => {
		let fail = false
		let failures = 0
		const disk = memDisk((op, at) => {
			if (!fail || op !== 'write' || !at.endsWith('index.json')) return null
			fail = false
			failures++
			return 'EIO'
		})
		const store = fsStore('mem', { disk })
		built.push(store)
		await store.since()
		const notices: Node[][] = []
		store.subscribe?.((rows) => notices.push(rows))
		const path = under(AT_ROOT, 'a.txt')
		if (path === null) throw new Error('invalid test path')

		fail = true
		await disk.write(path, bytes('a'), undefined, 'unseen')
		for (let tries = 0; failures === 0 && tries < 20; tries++)
			await new Promise((resolve) => setTimeout(resolve, 1))
		expect(failures).toBe(1)
		expect(notices).toEqual([])

		await store.since()
		expect(notices.flat().some((node) => node.name === 'a.txt')).toBe(true)
		await store.close?.()
		const reopened = fsStore('mem', { disk })
		built.push(reopened)
		expect(await reopened.child(ROOT, 'a.txt')).not.toBeNull()
	})

	test('close while open is pending does not arm a watcher', async () => {
		const disk = memDisk()
		let release = (): void => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let firstRootStat = true
		let watches = 0
		const slow: Disk = {
			...disk,
			async stat(at) {
				if (at === AT_ROOT && firstRootStat) {
					firstRootStat = false
					await gate
				}
				return disk.stat(at)
			},
			watch(onPath, onLost) {
				watches++
				return disk.watch(onPath, onLost)
			}
		}
		const store = fsStore('mem', { disk: slow })
		built.push(store)
		store.subscribe?.(() => {})
		await new Promise((resolve) => setTimeout(resolve, 0))

		await store.close?.()
		release()
		await store.get(ROOT)
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(watches).toBe(0)
	})

	test('combined native hints publish one reconciled batch', async () => {
		const disk = memDisk()
		const store = fsStore('mem', { disk })
		built.push(store)
		await store.since()
		const notices: Node[][] = []
		store.subscribe?.((rows) => notices.push(rows))
		const a = under(AT_ROOT, 'a.txt')
		const b = under(AT_ROOT, 'b.txt')
		if (a === null || b === null) throw new Error('invalid test path')

		await disk.write(a, bytes('a'), undefined, 'unseen')
		await disk.write(b, bytes('b'), undefined, 'unseen')
		await new Promise((resolve) => setTimeout(resolve, 10))

		expect(notices).toHaveLength(1)
		expect(notices[0]?.map((node) => node.name)).toEqual(expect.arrayContaining(['a.txt', 'b.txt']))
		expect(await store.child(ROOT, 'a.txt')).not.toBeNull()
		expect(await store.child(ROOT, 'b.txt')).not.toBeNull()
	})

	test('the full scan finds a change when the watcher has no hint', async () => {
		const disk = memDisk()
		const store = fsStore('mem', { disk })
		built.push(store)
		const clock = vi.spyOn(Date, 'now')
		try {
			await store.commit([row('a', 'a.txt')])
			await store.since()
			const later = Date.now() + SWEEP_MS * 6
			const notices: Node[][] = []
			store.subscribe?.((rows) => notices.push(rows))
			const path = under(AT_ROOT, 'a.txt')
			if (path === null) throw new Error('invalid test path')

			await disk.stamp(path, { mode: 0o600, mtimeNs: 9_000_000n }, 'unseen')
			clock.mockReturnValue(later)
			await new Promise((resolve) => setTimeout(resolve, 10))

			expect((await store.get('a'))?.mode).toBe(0o100600)
			expect(notices.flat().some((node) => node.id === 'a')).toBe(true)
		} finally {
			await store.close?.()
			clock.mockRestore()
		}
	})

	test('unsubscribe and close stop later callbacks', async () => {
		const disk = memDisk()
		const store = fsStore('mem', { disk })
		built.push(store)
		await store.since()
		let calls = 0
		const stop = store.subscribe?.(() => calls++)
		stop?.()
		const a = under(AT_ROOT, 'a.txt')
		if (a === null) throw new Error('invalid test path')
		await disk.write(a, bytes('a'), undefined, 'unseen')
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(calls).toBe(0)

		store.subscribe?.(() => calls++)
		await store.close?.()
		const b = under(AT_ROOT, 'b.txt')
		if (b === null) throw new Error('invalid test path')
		await disk.write(b, bytes('b'), undefined, 'unseen')
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(calls).toBe(0)
	})

	test('the default version source keeps a private fs author', async () => {
		const disk = memDisk()
		const store = fsStore('mem', { disk })
		built.push(store)
		await store.since()
		const path = under(AT_ROOT, 'a.txt')
		if (path === null) throw new Error('invalid test path')

		await disk.write(path, bytes('a'), undefined, 'unseen')
		await store.since()
		const found = await store.child(ROOT, 'a.txt')
		expect(authorOf(found?.version ?? '')).toMatch(/^fs:/)
	})
})

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
		await disk.write(file, bytes('hello'), undefined, 'unseen')

		expect(await disk.list(dir)).toEqual(['a.txt'])
		await disk.stamp(dir, { mode: 0o300 }, 'unseen') // write and search, but no read
		expect(await disk.list(dir)).toBeNull()
		// And what is under it is still reachable, because search is still granted.
		expect(await disk.stat(file)).not.toBeNull()

		await disk.stamp(dir, { mode: 0o600 }, 'unseen') // read and write, but no search
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

		await disk.write(a, bytes('one'), undefined, 'unseen')
		const first = await disk.stat(a)
		if (first === null) throw new Error('unreachable')

		await disk.write(a, bytes('two'), undefined, 'unseen')
		const second = await disk.stat(a)
		expect(second?.ino).not.toBe(first.ino)

		if (second === null) throw new Error('unreachable')
		const at = { path: a, ino: String(second.ino), state: stateOf(second) }
		// And the move hands back the inode it carried, not merely that it happened.
		expect((await disk.move(at, b))?.ino).toBe(String(second?.ino))
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
		await disk.write(a, bytes('hello'), undefined, 'unseen')

		await disk.stamp(a, { mode: 0o644, mtimeNs: 1_234_567_891_234_567n }, 'unseen')
		expect((await disk.stat(a))?.mtimeNs).toBe(1_234_567_891_000_000n)
	})
})

describe('fsStore over memDisk: a fault is not a lie', () => {
	test('an index it cannot read is never taken for a tree with no history', async () => {
		// Rule 11 and the worst failure this backend has: reading the sidecar as
		// absent mints a new lineage, rebinds every id, and then saves over the index
		// that could have said otherwise.
		const disk = memDisk((op, at) => (op === 'read' && at.endsWith('index.json') ? 'EACCES' : null))
		const store = fsStore('mem', { disk: disk })
		await expect(store.get(ROOT)).rejects.toThrow(/EACCES/)
	})
})

test('a write that carries an observation lands only while it holds', async () => {
	// The whole state and not just the inode: `echo x > f` truncates in place and keeps
	// it, so a check that only asked whose inode it was would miss the commonest edit.
	const disk = memDisk()
	const at = under(AT_ROOT, 'a.txt')
	if (at === null) throw new Error('unreachable')
	await disk.write(at, bytes('hello'), undefined, 'unseen')
	const s = await disk.stat(at)
	if (s === null) throw new Error('unreachable')
	const was = { path: at, ino: String(s.ino), state: stateOf(s) }

	const landed = await disk.write(at, bytes('again'), undefined, was)
	// What comes back is the file this write left, which is what makes it safe to record.
	expect(landed?.ino).toBe(String((await disk.stat(at))?.ino))
	// And now the observation is stale, because that write moved it.
	expect(await disk.write(at, bytes('third'), undefined, was)).toBeNull()
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
					await disk.write(spot, bytes('goodbye'), undefined, 'unseen')
				}
				return disk.bytes(spot, strict)
			}
		}
		const store = fsStore('mem', { disk: racy })
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
		const store = fsStore('mem', { disk: disk })
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

		await disk.write(at, bytes('mine, typed while waiting'), undefined, 'unseen')
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
				if (spot === meddle && ++looks === 1)
					await disk.write(spot, bytes('typed by a local tool'), undefined, 'unseen')
				return s
			}
		}
		const store = fsStore('mem', { disk: racy })
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
		const store = fsStore('mem', { disk: disk })
		built.push(store)
		await store.commit([folder()])
		await store.since()

		const at = under(AT_ROOT, 'folder')
		if (at === null) throw new Error('unreachable')
		const child = under(at, 'local.txt')
		if (child === null) throw new Error('unreachable')
		await disk.write(child, bytes('the only copy of this'), undefined, 'unseen')

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
		const store = fsStore('mem', { disk: disk })
		built.push(store)
		await store.commit([folder()])
		await store.since()

		const at = under(AT_ROOT, 'folder')
		if (at === null) throw new Error('unreachable')
		const child = under(at, 'local.txt')
		if (child === null) throw new Error('unreachable')
		await disk.write(child, bytes('behind a shut door'), undefined, 'unseen')
		await disk.stamp(at, { mode: 0o000 }, 'unseen') // no read, no search

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
		const store = fsStore('mem', {
			disk: memDisk((op, at) => (op === 'stamp' && at === 'a.txt' ? 'EPERM' : null))
		})
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

describe('fsStore: a commit that publishes nothing still claims nothing', () => {
	test('a metadata-only change does not stamp, or vouch for, a file it did not put there', async () => {
		// A chmod, or a re-commit of a row whose file already holds its content, has no
		// payload to ride in with — so the stamp goes on the NAME, and a name can change
		// hands between `settle` looking and the stamp landing. Stamping a stranger and
		// then recording the row's hash beside its state would read as reconciled: the
		// scan would skip those bytes for ever, and `blobs` would answer them under a key
		// that does not name them.
		const disk = memDisk()
		let meddle: Spot | null = null
		const racy: Disk = {
			// `unlockFor` runs inside the placement, after `settle` has looked and before
			// anything is put on the name. A local write landing here is the window.
			...disk,
			async unlock(steps) {
				if (meddle !== null) {
					const spot = meddle
					meddle = null
					await disk.write(spot, bytes('typed by a local tool'), undefined, 'unseen')
				}
				return disk.unlock(steps)
			}
		}
		const store = fsStore('mem', { disk: racy })
		built.push(store)
		const at = under(AT_ROOT, 'a.txt')
		if (at === null) throw new Error('unreachable')

		const key = 'e'.repeat(64)
		const same = (mode: number, version: string): Node => ({
			id: 'a',
			parent: ROOT,
			name: 'a.txt',
			type: 'file',
			mode,
			size: 5n,
			mtimeNs: 0n,
			content: key,
			version
		})
		await store.blobs.put(key, bytes('hello'))
		await store.commit([same(0o100644, 'v1')])
		await store.since()

		meddle = at
		await store.commit([same(0o100600, 'v2')]) // same content, new mode
		meddle = null

		expect(await disk.bytes(at)).toEqual(bytes('typed by a local tool'))
		await new Promise((resolve) => setTimeout(resolve, SWEEP_MS * 6))
		await store.since()
		expect({
			content: (await store.get('a'))?.content,
			// The store no longer holds `hello` — that file was its only copy — and it does
			// not offer what took its place instead.
			leaked: await store.blobs.get(key)
		}).toEqual({
			content: await sha256Hex(bytes('typed by a local tool')),
			leaked: null
		})
	}, 30_000)

	test('a stamp that landed on a stranger is not recorded as a placement', async () => {
		// The check before the act only buys a narrower window; this one is asked on the
		// other side of it. A local writer arriving between the two gets stamped — a lost
		// write, which the next scan reports — but nothing is claimed about the file it
		// left, which is the part that would otherwise be permanent.
		const disk = memDisk()
		let meddle: Spot | null = null
		const racy: Disk = {
			...disk,
			async stamp(spot, on, was) {
				if (spot === meddle) {
					meddle = null
					await disk.write(spot, bytes('typed by a local tool'), undefined, 'unseen')
				}
				return disk.stamp(spot, on, was)
			}
		}
		const store = fsStore('mem', { disk: racy })
		built.push(store)
		const at = under(AT_ROOT, 'a.txt')
		if (at === null) throw new Error('unreachable')

		const key = 'e'.repeat(64)
		const same = (mode: number, version: string): Node => ({
			id: 'a',
			parent: ROOT,
			name: 'a.txt',
			type: 'file',
			mode,
			size: 5n,
			mtimeNs: 0n,
			content: key,
			version
		})
		await store.blobs.put(key, bytes('hello'))
		await store.commit([same(0o100644, 'v1')])
		await store.since()

		meddle = at
		await store.commit([same(0o100600, 'v2')])
		meddle = null

		await new Promise((resolve) => setTimeout(resolve, SWEEP_MS * 6))
		await store.since()
		expect({
			content: (await store.get('a'))?.content,
			leaked: await store.blobs.get(key)
		}).toEqual({ content: await sha256Hex(bytes('typed by a local tool')), leaked: null })
	}, 30_000)

	test('a directory replaced by a file is not recorded under the directory row', async () => {
		// A directory's state is meant to move while a batch runs — an entry landing inside
		// it bumps its mtime, which is why the observation waits until the end. Its inode
		// is not. Without holding it to that, a local tool replacing the directory with a
		// file has that file's state recorded under a row that still says directory, and
		// `syncPath` takes the unchanged path straight past it: nothing ever lists it, and
		// the bytes that took its name never reach the feed at all.
		const disk = memDisk()
		let meddle: Spot | null = null
		const racy: Disk = {
			...disk,
			async stamp(spot, on) {
				const done = await disk.stamp(spot, on, 'unseen')
				// Placed and stamped; the batch has not observed it yet.
				if (spot === meddle) {
					meddle = null
					await disk.clear(spot)
					await disk.write(spot, bytes('a file now'), undefined, 'unseen')
				}
				return done
			}
		}
		const store = fsStore('mem', { disk: racy })
		built.push(store)
		const at = under(AT_ROOT, 'folder')
		if (at === null) throw new Error('unreachable')

		meddle = at
		await store.commit([
			{
				id: 'd',
				parent: ROOT,
				name: 'folder',
				type: 'dir',
				mode: 0o040755,
				size: 0n,
				mtimeNs: 0n,
				version: 'v1'
			}
		])
		meddle = null
		expect((await disk.stat(at))?.isFile()).toBe(true)

		await new Promise((resolve) => setTimeout(resolve, SWEEP_MS * 6))
		await store.since()
		const row = await store.child(ROOT, 'folder')
		expect({ type: row?.type, content: row?.content }).toEqual({
			type: 'file',
			content: await sha256Hex(bytes('a file now'))
		})
	}, 30_000)

	test('a commit does not rename over bytes it never saw', async () => {
		// The ordinary case, and the one with the most to lose: a page changes the content of
		// a file this store already tracks. The commit looked at the name before it began, but
		// fetching the payload and building it beside the name take time a local tool can type
		// into — and those bytes are the only copy of themselves there is. So the placement
		// carries the observation too, and a stale one lands nothing at all.
		const disk = memDisk()
		let meddle: Spot | null = null
		const racy: Disk = {
			...disk,
			async write(spot, data, on, was) {
				// After the commit looked, before the payload takes the name.
				if (spot === meddle) {
					meddle = null
					await disk.write(spot, bytes('typed by a local tool'), undefined, 'unseen')
				}
				return disk.write(spot, data, on, was)
			}
		}
		const store = fsStore('mem', { disk: racy })
		built.push(store)
		const at = under(AT_ROOT, 'a.txt')
		if (at === null) throw new Error('unreachable')

		const first = 'a'.repeat(64)
		const second = 'b'.repeat(64)
		const row = (content: string, version: string): Node => ({
			id: 'a',
			parent: ROOT,
			name: 'a.txt',
			type: 'file',
			mode: 0o100644,
			size: 5n,
			mtimeNs: 0n,
			content,
			version
		})
		await store.blobs.put(first, bytes('hello'))
		await store.blobs.put(second, bytes('goodbye'))
		await store.commit([row(first, 'v1')])
		await store.since()
		expect(await disk.bytes(at)).toEqual(bytes('hello'))

		meddle = at
		await store.commit([row(second, 'v2')])
		meddle = null

		// The local edit is still there — the page's bytes did not take the name from it.
		expect(await disk.bytes(at)).toEqual(bytes('typed by a local tool'))
		await new Promise((resolve) => setTimeout(resolve, SWEEP_MS * 6))
		await store.since()
		// And the scan makes the edit the row's own content, which is what puts it on the feed.
		expect((await store.get('a'))?.content).toEqual(await sha256Hex(bytes('typed by a local tool')))
	}, 30_000)
})
