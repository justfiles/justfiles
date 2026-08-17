/**
 * The `Store` over a real directory. The conformance suite runs against a temp
 * dir like every other backend, and the cases below are the ones only this
 * backend has to answer for: the files ARE the data, so a change nobody
 * announced has to become a row, and a reopen must not mint a second id for a
 * file that already has one.
 */

import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	stat,
	utimes,
	writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { type Cursor, GuardError, type Node, ROOT, type Store, sha256Hex } from './store'
import { storeConformance } from './store.conformance'
import { fsStore, SWEEP_MS } from './store.fs'

/**
 * Every store this file builds, closed when the case ends. A `Store` is closed by
 * whoever constructed it and by nobody else, so here that is the test.
 */
const built: Store[] = []
const open = (root: string): Store => {
	const store = fsStore(root)
	built.push(store)
	return store
}
afterEach(async () => {
	for (const store of built.splice(0)) await store.close?.()
})

const temp = (): Promise<string> => mkdtemp(join(tmpdir(), 'jfs-t14-'))

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const read = (data: Uint8Array | null): string | null =>
	data === null ? null : new TextDecoder().decode(data)

/** Scan the feed to its end, as the conformance suite does. */
async function feed(store: Store, from?: Cursor): Promise<{ nodes: Node[]; cursor: Cursor }> {
	const nodes: Node[] = []
	let cursor = from
	for (let page = 0; page < 100; page++) {
		const got = await store.since(cursor)
		if (got.next === undefined) throw new Error('since must always hand a cursor back')
		cursor = got.next
		if (got.nodes.length === 0) return { nodes, cursor }
		nodes.push(...got.nodes)
	}
	throw new Error('since never caught up')
}

/**
 * Give the OS its moment. A watcher-driven store hears about a change made
 * outside it when the platform says so, not when a test is ready — so a case
 * that waits for one polls the feed, exactly as a consumer does.
 */
async function settled(store: Store, ready: () => Promise<boolean>): Promise<void> {
	// Long enough to outlast the deep floor: a watcher that dropped the event costs
	// this case a wait, never an answer (see `DEEP_MS`).
	for (let tries = 0; tries < 800; tries++) {
		await store.since()
		if (await ready()) return
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error('the change never reached the store')
}

const named = (nodes: Node[], name: string): Node => {
	const row = nodes.find((n) => n.name === name)
	if (!row) throw new Error(`no row named ${name} in [${nodes.map((n) => n.name).join(', ')}]`)
	return row
}

/** A file row under root, with the bytes made durable first (rule 10). */
async function place(store: Store, name: string, content: string): Promise<Node> {
	const data = bytes(content)
	const hash = await sha256Hex(data)
	await store.blobs.put(hash, data)
	const row: Node = {
		id: crypto.randomUUID(),
		parent: ROOT,
		name,
		type: 'file',
		mode: 0o100644,
		mtimeNs: 0n,
		size: BigInt(data.length),
		content: hash,
		version: 'v1'
	}
	await store.commit([row])
	return row
}

// Every `open()` is its own directory, so two of them are two stores — and two
// lineages, which is what the cursor case in the suite asks for.
storeConformance('fsStore', async () => open(await temp()))

describe('fsStore: a real directory, reconciled', () => {
	test('a commit lands as real files a local tool can read', async () => {
		const root = await temp()
		const store = open(root)
		const dir: Node = {
			id: 'd',
			parent: ROOT,
			name: 'notes',
			type: 'dir',
			mode: 0o040755,
			mtimeNs: 0n,
			size: 0n,
			version: 'v1'
		}
		await store.commit([dir])
		const data = bytes('# hello\n')
		const hash = await sha256Hex(data)
		await store.blobs.put(hash, data)
		await store.commit([
			{
				id: 'f',
				parent: 'd',
				name: 'a.md',
				type: 'file',
				mode: 0o100755,
				mtimeNs: 0n,
				size: BigInt(data.length),
				content: hash,
				version: 'v1'
			}
		])

		// The whole point of this backend: `cat` works, and so does everything else
		// that only knows about paths.
		expect(await readFile(join(root, 'notes/a.md'), 'utf8')).toBe('# hello\n')
		expect(await readdir(join(root, 'notes'))).toEqual(['a.md'])
		// The mode reaches the file, so an executable row is executable on disk.
		expect((await stat(join(root, 'notes/a.md'))).mode & 0o777).toBe(0o755)
	})

	test('content is the file itself: the blob store keeps no second copy', async () => {
		const root = await temp()
		const store = open(root)
		const row = await place(store, 'a.txt', 'hello')
		if (row.content === undefined) throw new Error('the row lost its content hash')

		// The bytes were handed over before the row, and once the row named them
		// the file is where they live — the sidecar holds nothing but the index.
		expect(await readdir(join(root, '.jfs/blobs'))).toEqual([])
		expect(read(await store.blobs.get(row.content))).toBe('hello')
		expect(await store.blobs.has(row.content)).toBe(true)
	})

	test('a reopen is not a reset: minted ids and cursors survive in the sidecar', async () => {
		const root = await temp()
		await writeFile(join(root, 'note.md'), 'hello')
		const one = open(root)
		const first = await feed(one)
		const minted = named(first.nodes, 'note.md')
		expect(minted.size).toBe(5n)

		// A second store over the same directory finds the sidecar, so the file it
		// scans is the node it already was — an id is minted once, never rebound.
		const two = open(root)
		expect(await two.child(ROOT, 'note.md')).toEqual(minted)
		expect((await two.get(minted.id))?.name).toBe('note.md')
		// Same lineage, and nothing to report: a restart is not news.
		expect((await two.since(first.cursor)).nodes).toEqual([])
	})

	test('an out-of-band edit appears in since', async () => {
		const root = await temp()
		const store = open(root)
		const row = await place(store, 'a.txt', 'hello')
		const { cursor } = await feed(store)

		await writeFile(join(root, 'a.txt'), 'edited by somebody else')
		await settled(store, async () => (await store.get(row.id))?.size === 23n)
		const changed = (await feed(store, cursor)).nodes
		expect(changed.map((n) => n.id)).toEqual([row.id])
		const [edited] = changed
		if (!edited) throw new Error('the edit never reached the feed')
		expect(edited.size).toBe(23n)
		expect(edited.content).toBe(await sha256Hex(bytes('edited by somebody else')))
		expect(edited.version).not.toBe(row.version)
		// The row and the bytes agree: the content hash answers from the file.
		expect(read(await store.blobs.get(edited.content ?? ''))).toBe('edited by somebody else')
		// And a second look finds nothing: an observed file is not news twice.
		expect((await feed(store, cursor)).nodes.map((n) => n.id)).toEqual([row.id])
		expect((await feed(store)).nodes.filter((n) => n.id === row.id).length).toBe(1)
	}, 30_000)

	test('an in-place edit that puts the stamp back still reaches the feed', async () => {
		const root = await temp()
		const store = open(root)
		// The row states its stamp and the file carries it, so it can be put back to the
		// nanosecond — which is what makes this case constructible at all.
		const row = await place(store, 'a.txt', 'hello')
		const { cursor } = await feed(store)
		const at = join(root, 'a.txt')

		// Same length, same mode, same stamp: what a metadata-preserving sync leaves
		// behind. Only the ctime moves, and nothing else tells this from the file the
		// store recorded — while the row's hash names bytes the file no longer holds.
		await writeFile(at, 'HELLO')
		await utimes(at, new Date(0), new Date(0))
		const hash = await sha256Hex(bytes('HELLO'))
		await settled(store, async () => (await store.get(row.id))?.content === hash)

		expect((await feed(store, cursor)).nodes.map((n) => n.id)).toEqual([row.id])
		expect(read(await store.blobs.get(hash))).toBe('HELLO')
	}, 30_000)

	test('an out-of-band create, delete and subtree removal reach the feed', async () => {
		const root = await temp()
		const store = open(root)
		const gone = await place(store, 'gone.txt', 'bye')
		const { cursor } = await feed(store)

		await mkdir(join(root, 'sub/deep'), { recursive: true })
		await writeFile(join(root, 'sub/deep/new.txt'), 'fresh')
		await rm(join(root, 'gone.txt'))
		await settled(
			store,
			async () =>
				(await store.child(ROOT, 'gone.txt')) === null && (await store.child(ROOT, 'sub')) !== null
		)

		const caught = await feed(store, cursor)
		const rows = caught.nodes
		// The new tree arrives as rows, root included: adding an entry bumped the
		// directory's own mtime, and that is a change like any other.
		expect(named(rows, 'sub').type).toBe('dir')
		expect(named(rows, 'deep').parent).toBe(named(rows, 'sub').id)
		expect(named(rows, 'new.txt').content).toBe(await sha256Hex(bytes('fresh')))
		expect(rows.some((n) => n.id === ROOT)).toBe(true)
		// A file that is not there any more is a tombstone.
		expect(rows.find((n) => n.id === gone.id)?.deleted).toBe(true)
		expect(await store.child(ROOT, 'gone.txt')).toBeNull()

		// A whole subtree removed out of band tombstones every row under it.
		const deep = named(rows, 'deep')
		const inner = named(rows, 'new.txt')
		await rm(join(root, 'sub'), { recursive: true })
		await settled(store, async () => (await store.get(inner.id))?.deleted === true)
		const after = (await feed(store, caught.cursor)).nodes
		expect(
			after
				.filter((n) => n.deleted)
				.map((n) => n.id)
				.sort()
		).toEqual([named(rows, 'sub').id, deep.id, inner.id].sort())
	}, 30_000)

	test('a directory rename moves the subtree on disk and keeps every id', async () => {
		const root = await temp()
		await mkdir(join(root, 'old/deep'), { recursive: true })
		await writeFile(join(root, 'old/deep/note.md'), 'kept')
		const store = open(root)
		const before = (await feed(store)).nodes
		const dir = named(before, 'old')
		const deep = named(before, 'deep')
		const note = named(before, 'note.md')

		// One row moves — the design's O(1) move — and on a real filesystem that is
		// one `rename`, whatever the subtree under it holds.
		await store.commit([{ ...dir, name: 'new', version: 'v2' }])
		expect(await readFile(join(root, 'new/deep/note.md'), 'utf8')).toBe('kept')
		expect((await readdir(root)).sort()).toEqual(['.jfs', 'new'])
		// The children never moved: same ids, same rows, and the paths the store
		// tracks for them followed the parent.
		expect((await store.get(deep.id))?.name).toBe('deep')
		expect(await store.child(deep.id, 'note.md')).toEqual(note)
		expect(read(await store.blobs.get(note.content ?? ''))).toBe('kept')
		// And the scan agrees: nothing was lost or found by the move.
		expect((await feed(store)).nodes.filter((n) => n.deleted)).toEqual([])
	})

	test('a batch that names a child before its parent still lands', async () => {
		const root = await temp()
		const store = open(root)
		const dir: Node = {
			id: 'd',
			parent: ROOT,
			name: 'sub',
			type: 'dir',
			mode: 0o040755,
			mtimeNs: 0n,
			size: 0n,
			version: 'v1'
		}
		const link: Node = {
			id: 'l',
			parent: 'd',
			name: 'link',
			type: 'symlink',
			mode: 0o120777,
			mtimeNs: 0n,
			size: 12n,
			link: '../elsewhere',
			version: 'v1'
		}
		// A commit is not ordered inside itself, so a store cannot ask for parents
		// first — the engine applies whatever order the feed handed it.
		await store.commit([link, dir])

		expect(await readdir(join(root, 'sub'))).toEqual(['link'])
		expect(await readlink(join(root, 'sub/link'))).toBe('../elsewhere')
		// And the disk says back what the rows said: the scan finds no news.
		const caught = await feed(store)
		expect(caught.nodes.map((n) => n.id).sort()).toEqual([ROOT, 'd', 'l'].sort())
		expect((await feed(store, caught.cursor)).nodes).toEqual([])
	})

	test('a lazy stub keeps the name, and the bytes fill it in when they arrive', async () => {
		const root = await temp()
		const store = open(root)
		const data = bytes('arrived late')
		const hash = await sha256Hex(data)
		const stub: Node = {
			id: 's',
			parent: ROOT,
			name: 'later.md',
			type: 'file',
			mode: 0o100644,
			mtimeNs: 0n,
			size: BigInt(data.length),
			content: hash,
			version: 'v1'
		}
		await store.commit([stub])
		// The row is whole and the bytes were never fetched (rules 7, 10): the name
		// is there, empty, and the row still states the content it waits for.
		expect(await readFile(join(root, 'later.md'), 'utf8')).toBe('')
		expect(await store.get('s')).toEqual(stub)
		expect(await store.blobs.has(hash)).toBe(false)
		// A scan does not mistake the placeholder for an out-of-band truncation.
		const caught = await feed(store)
		expect((await feed(store, caught.cursor)).nodes).toEqual([])

		await store.blobs.put(hash, data)
		await store.commit([{ ...stub, version: 'v2' }])
		expect(await readFile(join(root, 'later.md'), 'utf8')).toBe('arrived late')
		expect(read(await store.blobs.get(hash))).toBe('arrived late')
	})

	test('a row with no place in the tree is held, and lands when one is given', async () => {
		const root = await temp()
		const store = open(root)
		const dir: Node = {
			id: 'd',
			parent: ROOT,
			name: 'sub',
			type: 'dir',
			mode: 0o040755,
			mtimeNs: 0n,
			size: 0n,
			version: 'v1'
		}
		const child: Node = {
			id: 'c',
			parent: 'd',
			name: 'c.txt',
			type: 'file',
			mode: 0o100644,
			mtimeNs: 0n,
			size: 0n,
			version: 'v1'
		}

		// Rule 9: a replica may hold a row whose parent has not arrived. It has no
		// path on a filesystem, so it is a row and nothing else — which is exactly
		// what "invisible until reachable" means here.
		await store.commit([child])
		expect(await store.get('c')).toEqual(child)
		expect(await readdir(root)).toEqual(['.jfs'])
		// And the scan does not bury it: a row the disk never held cannot be missing
		// from it.
		const caught = await feed(store)
		expect(caught.nodes.find((n) => n.id === 'c')?.deleted).toBeUndefined()

		// The parent arrives, and the row it makes reachable lands with it. Committing
		// that row again is then a no-op — unless the disk never got it, which is how a
		// retry after a write that failed halfway heals (rule 3).
		await store.commit([dir])
		await store.commit([child])
		expect(await readdir(join(root, 'sub'))).toEqual(['c.txt'])
		// Only the directory row is news: the store made this change itself, so root's
		// bumped mtime is not a change to report — a volume stamps a parent by
		// committing it, and nothing else may.
		expect((await feed(store, caught.cursor)).nodes.map((n) => n.id)).toEqual(['d'])
	})

	test('a scan on open adopts a tree the store has never seen', async () => {
		const root = await temp()
		await mkdir(join(root, 'a/b'), { recursive: true })
		await writeFile(join(root, 'a/b/c.txt'), 'deep')
		const store = open(root)

		// No `since` first: the index is rebuilt by the scan on open, so a path
		// resolves the moment the store is there.
		const a = await store.child(ROOT, 'a')
		if (!a) throw new Error('the scan on open missed a/')
		const b = await store.child(a.id, 'b')
		if (!b) throw new Error('the scan on open missed a/b/')
		const c = await store.child(b.id, 'c.txt')
		expect(c?.size).toBe(4n)
		expect(read(await store.blobs.get(c?.content ?? ''))).toBe('deep')
	})
})

/**
 * The findings from the reviews of #521, each as the case that shows it. Every one
 * of them is about the same two questions the first cut never asked: WHO owns a
 * path on disk, and where does a row live when it cannot have one.
 */
describe('fsStore: what a row owns, and what happens when nothing can reach it', () => {
	const dir = (over: Partial<Node> & Pick<Node, 'id' | 'name'>): Node => ({
		parent: ROOT,
		type: 'dir',
		mode: 0o040755,
		mtimeNs: 0n,
		size: 0n,
		version: 'v1',
		...over
	})

	test('a tombstone on a directory alone keeps what its live children hold', async () => {
		const root = await temp()
		const store = open(root)
		const sub = dir({ id: 'd', name: 'sub' })
		await store.commit([sub])
		const data = bytes('keep me')
		const hash = await sha256Hex(data)
		await store.blobs.put(hash, data)
		const child: Node = {
			id: 'c',
			parent: 'd',
			name: 'c.txt',
			type: 'file',
			mode: 0o100644,
			mtimeNs: 0n,
			size: BigInt(data.length),
			content: hash,
			version: 'v1'
		}
		await store.commit([child])
		const { cursor } = await feed(store)

		// Only the directory is tombstoned. Its children stay live rows — mid-sync
		// that is an ordinary page boundary (rule 9), not a deletion.
		await store.commit([{ ...sub, deleted: true, version: 'v2' }])

		expect(await store.get('c')).toEqual(child)
		// The row still names its content, so the content must still be here.
		expect(read(await store.blobs.get(hash))).toBe('keep me')
		// And the next scan must not turn a row nobody deleted into a tombstone.
		const rows = (await feed(store, cursor)).nodes
		expect(rows.filter((n) => n.deleted).map((n) => n.id)).toEqual(['d'])
	})

	test('a row the tree cannot reach leaves the namespace, keeps its bytes, and mints no ghost', async () => {
		const root = await temp()
		const store = open(root)
		const row = await place(store, 'a.txt', 'hello')
		const { cursor } = await feed(store)

		// A parent that does not exist: the row is live and invisible (rule 9), so
		// its file must leave the tree — otherwise the next scan finds an unclaimed
		// file and mints a second node for the same content.
		await store.commit([{ ...row, parent: 'nowhere', version: 'v2' }])
		expect((await readdir(root)).sort()).toEqual(['.jfs'])
		expect(await store.child(ROOT, 'a.txt')).toBeNull()
		const rows = (await feed(store, cursor)).nodes
		expect(rows.filter((n) => n.name === 'a.txt' && n.id !== row.id)).toEqual([])
		expect(read(await store.blobs.get(row.content ?? ''))).toBe('hello')

		// And when a commit gives it a place again, the bytes come back with it.
		await store.commit([{ ...row, version: 'v3' }])
		expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('hello')
	})

	test('a batch that renames a parent after touching its child still lands', async () => {
		const root = await temp()
		const store = open(root)
		const old = dir({ id: 'd', name: 'old' })
		await store.commit([old])
		const data = bytes('kept')
		const hash = await sha256Hex(data)
		await store.blobs.put(hash, data)
		const child: Node = {
			id: 'c',
			parent: 'd',
			name: 'c.txt',
			type: 'file',
			mode: 0o100644,
			mtimeNs: 0n,
			size: BigInt(data.length),
			content: hash,
			version: 'v1'
		}
		await store.commit([child])

		// The child comes first and resolves under the parent's NEW name, which is
		// only in the row the batch has not placed yet. A commit is not ordered
		// inside itself, so this order has to work.
		await store.commit([
			{ ...child, mode: 0o100600, version: 'v2' },
			{ ...old, name: 'new', version: 'v2' }
		])
		expect(await readFile(join(root, 'new/c.txt'), 'utf8')).toBe('kept')
		expect((await readdir(root)).sort()).toEqual(['.jfs', 'new'])
	})

	test('bytes arriving for a stub fill the file the row already has', async () => {
		const root = await temp()
		const store = open(root)
		const data = bytes('arrived late')
		const hash = await sha256Hex(data)
		const stub: Node = {
			id: 's',
			parent: ROOT,
			name: 'later.md',
			type: 'file',
			mode: 0o100644,
			mtimeNs: 0n,
			size: BigInt(data.length),
			content: hash,
			version: 'v1'
		}
		await store.commit([stub])
		const { cursor } = await feed(store)

		// `hydratingBlobs` puts and does not commit, so a put is the only chance the
		// file gets. A store whose whole point is that the files ARE the data cannot
		// leave `cat` reading an empty one.
		await store.blobs.put(hash, data)
		expect(await readFile(join(root, 'later.md'), 'utf8')).toBe('arrived late')
		// The row said this all along, so nothing changed: no feed traffic.
		expect(await store.get('s')).toEqual(stub)
		expect((await feed(store, cursor)).nodes).toEqual([])
	})

	/** A file row with the id the case chooses, and its bytes made durable first. */
	const file = async (store: Store, id: string, name: string, content: string): Promise<Node> => {
		const data = bytes(content)
		const hash = await sha256Hex(data)
		await store.blobs.put(hash, data)
		return {
			id,
			parent: ROOT,
			name,
			type: 'file',
			mode: 0o100644,
			mtimeNs: 0n,
			size: BigInt(data.length),
			content: hash,
			version: 'v1'
		}
	}

	test('two live rows for one name: the lowest id holds the file, the other keeps its bytes', async () => {
		// Both arrival orders, because the answer may not depend on which came first.
		for (const order of [
			['aaa', 'zzz'],
			['zzz', 'aaa']
		] as const) {
			const root = await temp()
			const store = open(root)
			const rows = {
				aaa: await file(store, 'aaa', 'dup.txt', 'the low id'),
				zzz: await file(store, 'zzz', 'dup.txt', 'the high id')
			}
			for (const id of order) await store.commit([rows[id]])

			// Two live rows for one name is a state the contract allows (rule 1), and only
			// one file can hold that name — so the disk holds the row `child` resolves.
			// Anything else and a local tool disagrees with the store about the same path.
			expect(await readFile(join(root, 'dup.txt'), 'utf8')).toBe('the low id')
			expect((await store.child(ROOT, 'dup.txt'))?.id).toBe('aaa')
			// The row that lost the name is still live, so its bytes are still here: on
			// this backend its file is the only copy there is.
			expect(await store.get('zzz')).toEqual(rows.zzz)
			expect(read(await store.blobs.get(rows.zzz.content ?? ''))).toBe('the high id')
			expect(read(await store.blobs.get(rows.aaa.content ?? ''))).toBe('the low id')
			// And the scan neither buries a row nobody deleted nor mints a ghost for a
			// file it finds: one name, two rows, no news.
			const scanned = (await feed(store)).nodes
			expect(scanned.filter((n) => n.deleted)).toEqual([])
			expect(
				scanned
					.filter((n) => n.name === 'dup.txt')
					.map((n) => n.id)
					.sort()
			).toEqual(['aaa', 'zzz'])
		}
	})

	test('when the row holding a contested name goes, the one that claimed it takes the file', async () => {
		const root = await temp()
		const store = open(root)
		const low = await file(store, 'aaa', 'dup.txt', 'the low id')
		const high = await file(store, 'zzz', 'dup.txt', 'the high id')
		await store.commit([low])
		await store.commit([high]) // parked: the lowest id holds the name

		// The row that held the name is buried, so the row that was waiting for it is
		// the winner now — and this is its only chance, because nothing looks inside
		// the holding area: not the scan, and not a commit that never names it.
		await store.commit([{ ...low, deleted: true, version: 'v2' }])

		expect(await store.child(ROOT, 'dup.txt')).toEqual(high)
		expect(await readFile(join(root, 'dup.txt'), 'utf8')).toBe('the high id')
		// The row never changed, only what the disk holds: the promotion is not news,
		// and the scan finds the file already accounted for.
		const rows = (await feed(store)).nodes
		expect(rows.filter((n) => n.deleted).map((n) => n.id)).toEqual(['aaa'])
		expect(await store.child(ROOT, 'dup.txt')).toEqual(high)
	})

	test('a child that arrived before its parent lands when the parent does', async () => {
		const root = await temp()
		const store = open(root)
		const child = { ...(await file(store, 'c', 'c.txt', 'kept')), parent: 'd' }

		// The page carrying a child routinely arrives before the one carrying its
		// parent — the feed puts a directory after the child whose creation stamped it
		// (rule 9). The engine's cursor is past that page for good, so the commit that
		// makes the row reachable is the only chance its file gets.
		await store.commit([child])
		await store.commit([dir({ id: 'd', name: 'sub' })])

		expect(await readFile(join(root, 'sub/c.txt'), 'utf8')).toBe('kept')
		expect(await store.get('c')).toEqual(child)
		// And what the disk holds is what the store said all along: no news, no ghost.
		const rows = (await feed(store)).nodes
		expect(rows.filter((n) => n.name === 'c.txt').map((n) => n.id)).toEqual(['c'])
	})

	test('a child whose parent is still a file waits for the page that makes it a directory', async () => {
		const root = await temp()
		const store = open(root)
		const parent = await file(store, 'd', 'sub', 'a file for now')
		await store.commit([parent])
		const child = { ...(await file(store, 'c', 'c.txt', 'kept')), parent: 'd' }

		// A batch that re-types a file as a directory and fills it can page the
		// children first. Until the page that re-types it lands, the parent is a file
		// and nothing is reachable through it — writing under it would fail with
		// ENOTDIR and wedge the replica on that page forever.
		await store.commit([child])
		expect(await store.get('c')).toEqual(child)
		expect(await readFile(join(root, 'sub'), 'utf8')).toBe('a file for now')

		await store.commit([
			{ ...parent, type: 'dir', mode: 0o040755, content: undefined, version: 'v2' }
		])
		expect(await readFile(join(root, 'sub/c.txt'), 'utf8')).toBe('kept')
	})

	test('a directory that becomes a file keeps what was inside it, bytes and all', async () => {
		const root = await temp()
		const store = open(root)
		await store.commit([dir({ id: 'd', name: 'sub' })])
		const inside = { ...(await file(store, 'c', 'c.txt', 'keep me')), parent: 'd' }
		await store.commit([inside])

		// A page that re-types the directory can land before the page that moves its
		// children out — rule 9 lets a replica hold exactly that, and the authority
		// takes the batch whose later pages empty it. The name has to become a file
		// here, but what was under it is still live rows nobody deleted.
		const retyped = { ...(await file(store, 'd', 'sub', 'now a file')), version: 'v2' }
		await store.commit([retyped])
		expect(await readFile(join(root, 'sub'), 'utf8')).toBe('now a file')
		expect(await store.get('c')).toEqual(inside)
		expect(read(await store.blobs.get(inside.content ?? ''))).toBe('keep me')

		// And the page that moves the child arrives: its bytes come back with it.
		await store.commit([{ ...inside, parent: ROOT, name: 'moved.txt', version: 'v2' }])
		expect(await readFile(join(root, 'moved.txt'), 'utf8')).toBe('keep me')
	})

	test('a mount that becomes a directory takes back what it was holding', async () => {
		const root = await temp()
		const store = open(root)
		const sub = dir({ id: 'd', name: 'sub' })
		await store.commit([sub])
		const inside = { ...(await file(store, 'c', 'c.txt', 'keep me')), parent: 'd' }
		await store.commit([inside])
		expect(await readFile(join(root, 'sub/c.txt'), 'utf8')).toBe('keep me')

		// A page re-types the directory as a junction. What was inside is not this
		// store's to hold there any more, so it is parked with its bytes.
		await store.commit([{ ...sub, type: 'mount', version: 'v2' }])
		expect(await readdir(join(root, 'sub'))).toEqual([])
		expect(read(await store.blobs.get(inside.content ?? ''))).toBe('keep me')

		// And the page that makes it a directory again: the rows are reachable, so the
		// files go back where the tree says. A junction is not the directory that
		// suppresses this — only a directory that was already one here is.
		await store.commit([{ ...sub, version: 'v3' }])
		expect(await readFile(join(root, 'sub/c.txt'), 'utf8')).toBe('keep me')
		expect(await store.get('c')).toEqual(inside)
	})

	test('the mode and the stamp a row states reach the disk, root included', async () => {
		const root = await temp()
		const store = open(root)
		// A whole number of milliseconds, which is all a POSIX stamp takes here.
		const when = 1_700_000_000_000_000_000n
		await store.commit([{ ...(await file(store, 'f', 'a.txt', 'hello')), mtimeNs: when }])
		expect((await stat(join(root, 'a.txt'), { bigint: true })).mtimeNs).toBe(when)

		const before = await store.get(ROOT)
		if (!before) throw new Error('the store has no root row')
		// Root is the one row with nothing to create, move or remove — but its mode and
		// its stamp are as real as any other row's, and this backend's whole premise is
		// that a local tool sees what the store says.
		await store.commit([{ ...before, mode: 0o040750, mtimeNs: when, version: 'v2' }])
		expect((await stat(root)).mode & 0o777).toBe(0o750)
		expect((await stat(root, { bigint: true })).mtimeNs).toBe(when)

		// And the store does not report its own change back to itself.
		const { cursor } = await feed(store)
		expect((await store.since(cursor)).nodes).toEqual([])
	})

	test('a name deleted outside goes to the row that was waiting for it', async () => {
		const root = await temp()
		const store = open(root)
		const low = await file(store, 'aaa', 'dup.txt', 'the low id')
		const high = await file(store, 'zzz', 'dup.txt', 'the high id')
		await store.commit([low])
		await store.commit([high]) // parked: the lowest id holds the name
		await feed(store)

		// A local tool takes the name away. That is a tombstone for the row that held
		// it, like any file deleted outside — and it makes the row that was waiting the
		// winner, exactly as a commit burying the holder would.
		await rm(join(root, 'dup.txt'))
		await settled(store, async () => (await store.get('aaa'))?.deleted === true)

		expect(await readFile(join(root, 'dup.txt'), 'utf8')).toBe('the high id')
		expect(await store.child(ROOT, 'dup.txt')).toEqual(high)
		// And what the scan put there is not news, and not a second node.
		const rows = (await feed(store)).nodes
		expect(rows.filter((n) => n.name === 'dup.txt' && !n.deleted).map((n) => n.id)).toEqual(['zzz'])
	}, 30_000)

	test('a directory that appears out of band takes in the rows that were waiting', async () => {
		const root = await temp()
		const store = open(root)
		const parent = await file(store, 'd', 'sub', 'a file for now')
		await store.commit([parent])
		const child = { ...(await file(store, 'c', 'c.txt', 'kept')), parent: 'd' }
		await store.commit([child]) // held: nothing is reachable through a file
		await feed(store)

		// The name becomes a directory before the page that re-types it arrives. The
		// scan is the only thing that will ever notice, so it is the only thing that
		// can put the rows waiting on it where they now belong — and the page, when it
		// comes, finds a directory already there and asks nothing.
		await rm(join(root, 'sub'))
		await mkdir(join(root, 'sub'))
		await settled(store, async () => (await store.get('d'))?.type === 'dir')

		expect(await readFile(join(root, 'sub/c.txt'), 'utf8')).toBe('kept')
		expect(await store.child('d', 'c.txt')).toEqual(child)
	}, 30_000)

	test('a directory replaced out of band by a file buries what it held', async () => {
		const root = await temp()
		await mkdir(join(root, 'sub'), { recursive: true })
		await writeFile(join(root, 'sub/note.md'), 'inside')
		const store = open(root)
		const before = (await feed(store)).nodes
		const sub = named(before, 'sub')
		const note = named(before, 'note.md')

		// The name survives, its kind does not. No directory will ever list those
		// entries again, so they are buried here or nowhere — and a live row nothing
		// can reach would go on holding the name at the authority.
		await rm(join(root, 'sub'), { recursive: true })
		await writeFile(join(root, 'sub'), 'a file now')
		await settled(store, async () => (await store.get(note.id))?.deleted === true)

		expect((await store.get(sub.id))?.type).toBe('file')
		expect((await store.get(note.id))?.deleted).toBe(true)
		expect(await store.child(sub.id, 'note.md')).toBeNull()
	}, 30_000)

	test('a free guard answers about the disk, not about the last time it looked', async () => {
		const root = await temp()
		const store = open(root)
		await feed(store) // the store has looked; the file arrives after

		// A local tool takes the name between two polls, and the app claims it with the
		// guard that means "no live node holds this" (rule 2). The answer has to come
		// from the disk: a guard checked against an index that has not looked since
		// passes, and the write then renames over bytes nobody ever published.
		await writeFile(join(root, 'a.txt'), 'the local tool wrote this')
		const row = await file(store, 'f', 'a.txt', 'and the app wrote this')

		await expect(store.commit([row], [{ free: { parent: ROOT, name: 'a.txt' } }])).rejects.toThrow(
			GuardError
		)

		// Nothing was lost, and the file is a row now — the create it always was.
		expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('the local tool wrote this')
		expect((await store.child(ROOT, 'a.txt'))?.content).toBe(
			await sha256Hex(bytes('the local tool wrote this'))
		)
	})

	test('a move looks at the file it is moving, not only where it is going', async () => {
		const root = await temp()
		const store = open(root)
		const row = await place(store, 'a.txt', 'hello')
		await feed(store)

		// Edited out of band, then moved by the app before any poll — with no guard, so
		// nothing refuses the move. A rename carries the file as it is NOW, so the look
		// has to cover the name the row is AT and not only the name it is going to.
		await writeFile(join(root, 'a.txt'), 'edited by somebody else')
		const edited = await sha256Hex(bytes('edited by somebody else'))
		await store.commit([{ ...row, name: 'moved.txt', version: 'v2' }])

		expect(await readFile(join(root, 'moved.txt'), 'utf8')).toBe('edited by somebody else')
		// The one thing content-addressing cannot survive: a hash that answers with bytes
		// which do not hash to it. The bytes on the disk answer under their own.
		expect(await store.blobs.get(row.content ?? '')).toBeNull()
		expect(read(await store.blobs.get(edited))).toBe('edited by somebody else')
		// The unguarded move landed, so the row the app wrote is the row — naming content
		// this replica does not hold, which is the stub state rule 7 has a place for.
		expect((await store.child(ROOT, 'moved.txt'))?.content).toBe(row.content)
	})

	test('a guarded move of a file edited outside is refused', async () => {
		const root = await temp()
		const store = open(root)
		const row = await place(store, 'a.txt', 'hello')
		await feed(store)

		// The same situation with the guard an app that cares would send: the base moved
		// under the read, so the move is refused and nothing on the disk is touched.
		await writeFile(join(root, 'a.txt'), 'edited by somebody else')
		await expect(
			store.commit(
				[{ ...row, name: 'moved.txt', version: 'v2' }],
				[{ version: { id: row.id, is: row.version } }]
			)
		).rejects.toThrow(GuardError)

		expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('edited by somebody else')
		expect(await store.child(ROOT, 'moved.txt')).toBeNull()
		expect((await store.child(ROOT, 'a.txt'))?.content).toBe(
			await sha256Hex(bytes('edited by somebody else'))
		)
	})

	test('a version guard fails when a local tool has deleted the row it names', async () => {
		const root = await temp()
		const store = open(root)
		const row = await place(store, 'a.txt', 'hello')
		await feed(store)

		// The other direction of the same question: gone is a change too. A local tool
		// removes the file between two polls, and the app commits a read-modify-write
		// against the version it last read — which must be refused, not quietly recreate
		// what somebody deleted.
		await rm(join(root, 'a.txt'))
		const data = bytes('rewritten from a stale read')
		const hash = await sha256Hex(data)
		await store.blobs.put(hash, data)

		await expect(
			store.commit(
				[{ ...row, content: hash, size: BigInt(data.length), version: 'v2' }],
				[{ version: { id: row.id, is: row.version } }]
			)
		).rejects.toThrow(GuardError)

		// The deletion is what the store says now, and the rejected commit wrote nothing.
		expect((await store.get(row.id))?.deleted).toBe(true)
		expect(await readdir(root)).toEqual(['.jfs'])
	})

	test('a version guard on root sees a chmod made outside', async () => {
		const root = await temp()
		const store = open(root)
		const before = await store.get(ROOT)
		if (!before) throw new Error('the store has no root row')
		await feed(store)

		// A local tool changes the mode of the directory this store IS, and the app
		// commits a read-modify-write of root's own row. Root has no name to look up and
		// no parent that lists it, so only `syncRoot` can answer for its state — and it
		// has to answer before a guard is judged, or the commit reapplies the mode the
		// caller last read and the change made outside is gone.
		await chmod(root, 0o750)
		await expect(
			store.commit(
				[{ ...before, mtimeNs: 1_700_000_000_000_000_000n, version: 'v2' }],
				[{ version: { id: ROOT, is: before.version } }]
			)
		).rejects.toThrow(GuardError)

		const now = await store.get(ROOT)
		expect(now?.mode === undefined ? null : now.mode & 0o7777).toBe(0o750)
		expect((await stat(root)).mode & 0o777).toBe(0o750)
	})

	test('a commit with no guard keeps the bytes of the file whose name it takes', async () => {
		const root = await temp()
		const store = open(root)
		await feed(store)
		await writeFile(join(root, 'a.txt'), 'the local tool wrote this')
		const local = await sha256Hex(bytes('the local tool wrote this'))
		const row = await file(store, 'aaa', 'a.txt', 'and the app wrote this')

		// No guard, so nothing refuses this write — but the file it takes the name from
		// was never published, and its bytes are the only copy there is. It becomes a row
		// first, and rule 1 then settles which of the two has the name; whichever loses
		// keeps its content either way.
		await store.commit([row])
		expect(read(await store.blobs.get(local))).toBe('the local tool wrote this')
		expect(read(await store.blobs.get(row.content ?? ''))).toBe('and the app wrote this')
	})

	test('two rows claiming one name in ONE batch: the lowest id lands, the other waits', async () => {
		const root = await temp()
		const store = open(root)
		const loser = { ...dir({ id: 'zzz', name: 'dup' }), version: 'v1' }
		const winner = { ...(await file(store, 'aaa', 'dup', 'the low id')), version: 'v1' }

		// One page can carry both, and a replica may hold both (rule 1). Only one file
		// can have the name, so the batch must not try to give it to two rows: the
		// second `rename` onto what the first left fails, and a page that cannot be
		// applied is a replica that never advances.
		await store.commit([loser, winner])

		expect(await readFile(join(root, 'dup'), 'utf8')).toBe('the low id')
		expect((await store.child(ROOT, 'dup'))?.id).toBe('aaa')
		// Both rows are live, and the one without the name is a row and nothing else.
		expect(await store.get('zzz')).toEqual(loser)
		expect((await feed(store)).nodes.filter((n) => n.deleted)).toEqual([])
	})

	test('a directory whose mode forbids writing still gets the children of its batch', async () => {
		const root = await temp()
		const store = open(root)
		const locked = { ...dir({ id: 'd', name: 'locked' }), mode: 0o040500 }
		const inside = { ...(await file(store, 'c', 'c.txt', 'kept')), parent: 'd' }

		// One batch: a read-only directory and a file inside it. The mode the row states
		// is the mode a local tool has to see — but stating it before the child lands
		// locks this store out of its own write, and a page it cannot apply is a replica
		// that never advances.
		await store.commit([locked, inside])

		expect(await readFile(join(root, 'locked/c.txt'), 'utf8')).toBe('kept')
		expect((await stat(join(root, 'locked'))).mode & 0o777).toBe(0o500)
	})

	test('a batch that unlocks a directory and fills it in one page lands', async () => {
		const root = await temp()
		const store = open(root)
		const locked = { ...dir({ id: 'd', name: 'locked' }), mode: 0o040500 }
		await store.commit([locked])
		const inside = { ...(await file(store, 'c', 'c.txt', 'kept')), parent: 'd' }

		// The page that unlocks the directory carries the child as well. Waiting for the
		// observation pass to state EVERY directory mode would hold the grant back past
		// the write that needs it, so the page that unlocks the parent is the one page
		// this replica could never apply.
		await store.commit([{ ...locked, mode: 0o040700, version: 'v2' }, inside])

		expect(await readFile(join(root, 'locked/c.txt'), 'utf8')).toBe('kept')
		expect((await stat(join(root, 'locked'))).mode & 0o777).toBe(0o700)
	})

	test('a batch that grants write and search, and fills the directory, lands', async () => {
		const root = await temp()
		const store = open(root)
		const shut = { ...dir({ id: 'd', name: 'shut' }), mode: 0o040100 }
		await store.commit([shut])
		const inside = { ...(await file(store, 'c', 'c.txt', 'kept')), parent: 'd' }

		// Putting an entry in a directory needs write and SEARCH, and not read. `0300`
		// is a mode this store can write into, so it is one to state before the child —
		// even though a scan could not list that directory afterwards.
		await store.commit([{ ...shut, mode: 0o040300, version: 'v2' }, inside])

		expect(await readFile(join(root, 'shut/c.txt'), 'utf8')).toBe('kept')
		expect((await stat(join(root, 'shut'))).mode & 0o777).toBe(0o300)
	})

	test('a child from a later page lands in a directory whose mode forbids the write', async () => {
		const root = await temp()
		const store = open(root)
		const locked = { ...dir({ id: 'd', name: 'locked' }), mode: 0o040500 }
		await store.commit([locked])
		const inside = { ...(await file(store, 'c', 'c.txt', 'kept')), parent: 'd' }

		// The page that fills the directory does not carry the directory, so nothing in it
		// grants the write POSIX wants on a parent — and a page that cannot be applied is
		// a replica that never advances. The directory is opened for the batch instead,
		// and closed again before it returns.
		await store.commit([inside])

		expect(await readFile(join(root, 'locked/c.txt'), 'utf8')).toBe('kept')
		expect((await stat(join(root, 'locked'))).mode & 0o777).toBe(0o500)

		// And out again: taking an entry away wants the same write.
		await store.commit([{ ...inside, deleted: true, version: 'v3' }])
		expect(await readdir(join(root, 'locked'))).toEqual([])
		expect((await stat(join(root, 'locked'))).mode & 0o777).toBe(0o500)
	})

	test('a child lands under an ancestor that cannot be searched', async () => {
		const root = await temp()
		const store = open(root)
		const outer = { ...dir({ id: 'o', name: 'outer' }), mode: 0o040400 }
		const inner = dir({ id: 'i', name: 'inner', parent: 'o' })
		await store.commit([outer, inner])
		const leaf = { ...(await file(store, 'c', 'f.txt', 'kept')), parent: 'i' }

		// `outer` has no search bit, so nothing under it can be reached at all — not the
		// write, and not the chmod that would allow the write. The way in is from the
		// outside in, one directory at a time, and the way out is the reverse.
		await store.commit([leaf])

		// Closed again before anything else looks — and closed so thoroughly that this
		// case cannot see past it either until it opens the way itself.
		expect((await stat(join(root, 'outer'))).mode & 0o777).toBe(0o400)
		await chmod(join(root, 'outer'), 0o700)
		expect((await stat(join(root, 'outer/inner'))).mode & 0o777).toBe(0o755)
		expect(await readFile(join(root, 'outer/inner/f.txt'), 'utf8')).toBe('kept')
	})

	test('a root nobody can search still saves its sidecar, and reopens', async () => {
		const root = await temp()
		const store = open(root)
		const before = await store.get(ROOT)
		if (!before) throw new Error('the store has no root row')
		const row = await place(store, 'a.txt', 'hello')

		// `chmod('/', 0400)`. This store's own index lives inside the directory it
		// describes, so a root nobody can search is a store that cannot write its sidecar
		// — and cannot read it back on the next open either, which loses every id.
		await store.commit([{ ...before, mode: 0o040400, version: 'v2' }])
		expect((await stat(root)).mode & 0o777).toBe(0o400)

		// It saved: a second store over the same directory finds the same ids and the same
		// lineage, rather than minting a new one and fencing every cursor.
		const two = open(root)
		expect((await two.child(ROOT, 'a.txt'))?.id).toBe(row.id)
		const seen = await two.get(ROOT)
		expect(seen === null ? null : seen.mode & 0o7777).toBe(0o400)
		expect((await stat(root)).mode & 0o777).toBe(0o400)
	})

	test('a row this store cannot look at is not a row that is gone', async () => {
		const root = await temp()
		const store = open(root)
		const outer = dir({ id: 'o', name: 'outer' })
		await store.commit([outer])
		const leaf = { ...(await file(store, 'c', 'f.txt', 'kept')), parent: 'o' }
		await store.commit([leaf])
		await store.commit([{ ...outer, mode: 0o040400, version: 'v2' }])
		await feed(store)

		// The look a commit takes before its guards cannot reach inside a directory with
		// no search bit — and "I cannot look" is not "it is gone". Burying on that would
		// tombstone a live row, save the tombstone, and then fail the guard against it.
		const data = bytes('rewritten')
		const hash = await sha256Hex(data)
		await store.blobs.put(hash, data)
		await store.commit(
			[{ ...leaf, content: hash, size: BigInt(data.length), version: 'v2' }],
			[{ version: { id: 'c', is: leaf.version } }]
		)

		expect((await store.get('c'))?.deleted).toBeUndefined()
		await chmod(join(root, 'outer'), 0o700)
		expect(await readFile(join(root, 'outer/f.txt'), 'utf8')).toBe('rewritten')
	})

	test('the way in and out of a locked directory is not news', async () => {
		const root = await temp()
		const store = open(root)
		const locked = { ...dir({ id: 'd', name: 'locked' }), mode: 0o040500 }
		await store.commit([locked])
		const inside = { ...(await file(store, 'c', 'c.txt', 'kept')), parent: 'd' }
		const { cursor } = await feed(store)

		// The child needs the directory opened and closed again. Neither the opening nor
		// the closing is a change anybody made, so a walk must not report one: this store
		// takes down what it did to the disk, the same as it does for a directory whose
		// mtime its own write moved.
		await store.commit([inside])
		// Long enough that both the watcher and the cheap floor have had their say.
		await new Promise((resolve) => setTimeout(resolve, SWEEP_MS))

		expect((await feed(store, cursor)).nodes.map((n) => n.id)).toEqual(['c'])
	}, 30_000)

	test('reopening a store whose root is locked reports nothing', async () => {
		const root = await temp()
		const store = open(root)
		const before = await store.get(ROOT)
		if (!before) throw new Error('the store has no root row')
		await store.commit([{ ...before, mode: 0o040400, version: 'v2' }])
		const { cursor } = await feed(store)

		// The open has to let itself in to read the index at all, and letting itself in
		// moves root's ctime. That is this store's own doing, so the walk that follows
		// must not report it: a restart is not news, locked root or not.
		const two = open(root)
		expect((await two.since(cursor)).nodes).toEqual([])
		expect((await stat(root)).mode & 0o777).toBe(0o400)
	})

	test('a mode set outside while the store was closed survives the reopen', async () => {
		const root = await temp()
		const store = open(root)
		const before = await store.get(ROOT)
		if (!before) throw new Error('the store has no root row')
		await store.commit([{ ...before, mode: 0o040400, version: 'v2' }])
		const { cursor } = await feed(store)
		await store.close?.()

		// A local tool sets another mode this store cannot write through. The reopen has
		// to let itself in past it — and has to put back what it FOUND, not what the
		// sidecar remembered, or opening the store quietly reverts somebody's chmod and
		// then records the revert as the truth.
		await chmod(root, 0o500)
		const two = open(root)
		const rows = (await feed(two, cursor)).nodes

		expect((await stat(root)).mode & 0o777).toBe(0o500)
		expect(rows.map((n) => n.id)).toEqual([ROOT])
		const now = await two.get(ROOT)
		expect(now === null ? null : now.mode & 0o7777).toBe(0o500)
	}, 30_000)

	test('a directory keeps the stamp its row states after an entry lands in it', async () => {
		const root = await temp()
		const store = open(root)
		const when = 1_700_000_000_000_000_000n
		const sub = { ...dir({ id: 'd', name: 'sub' }), mtimeNs: when }
		const inside = { ...(await file(store, 'c', 'c.txt', 'hello')), parent: 'd', mtimeNs: when }

		// One batch: a directory and the entry that goes in it. Creating the entry moves
		// the directory's own mtime, after the placement that stated it — so the row has
		// to get the last word, which is the whole point of a volume stamping a parent.
		await store.commit([sub, inside])
		expect((await stat(join(root, 'sub'), { bigint: true })).mtimeNs).toBe(when)
		expect((await stat(join(root, 'sub/c.txt'), { bigint: true })).mtimeNs).toBe(when)

		// And the store took that down rather than reporting it: no churn on the feed.
		const { cursor } = await feed(store)
		expect((await store.since(cursor)).nodes).toEqual([])
	})

	test('bytes arriving for a stub do not land on an edit made outside', async () => {
		const root = await temp()
		const store = open(root)
		const data = bytes('the bytes that were in flight')
		const hash = await sha256Hex(data)
		const stub: Node = {
			id: 's',
			parent: ROOT,
			name: 'later.md',
			type: 'file',
			mode: 0o100644,
			mtimeNs: 0n,
			size: BigInt(data.length),
			content: hash,
			version: 'v1'
		}
		await store.commit([stub])
		await feed(store)
		expect(await readFile(join(root, 'later.md'), 'utf8')).toBe('') // the placeholder

		// A local tool writes into the placeholder while the content is still on its way.
		// Nobody has published that edit, so the file is the only copy of it there is —
		// and a fetch that lands on top of it is the one thing this store must not do.
		await writeFile(join(root, 'later.md'), 'the local tool wrote this')
		await store.blobs.put(hash, data)

		expect(await readFile(join(root, 'later.md'), 'utf8')).toBe('the local tool wrote this')
		// The edit is a row now, and the bytes that arrived are still here for whoever
		// names them: content nobody references is allowed (rule 10).
		expect((await store.get('s'))?.content).toBe(
			await sha256Hex(bytes('the local tool wrote this'))
		)
		expect(read(await store.blobs.get(hash))).toBe('the bytes that were in flight')
	})

	test('bytes arriving for a stub do not cost the row its mode or its stamp', async () => {
		const root = await temp()
		const store = open(root)
		const data = bytes('#!/bin/sh\necho hi\n')
		const hash = await sha256Hex(data)
		const when = 1_700_000_000_000_000_000n
		const stub: Node = {
			id: 's',
			parent: ROOT,
			name: 'run.sh',
			type: 'file',
			mode: 0o100755,
			mtimeNs: when,
			size: BigInt(data.length),
			content: hash,
			version: 'v1'
		}
		await store.commit([stub])
		const { cursor } = await feed(store)

		// The file is REPLACED when the bytes land — one atomic rename over the name, so
		// what arrives is a new file with `writeFile`'s mode and this moment's stamp. An
		// executable that loses its execute bit the instant its content shows up is not
		// what the row says, and the row is what a local tool has to see.
		await store.blobs.put(hash, data)
		expect(await readFile(join(root, 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n')
		expect((await stat(join(root, 'run.sh'))).mode & 0o777).toBe(0o755)
		expect((await stat(join(root, 'run.sh'), { bigint: true })).mtimeNs).toBe(when)
		// The row stated all of it already, so none of it is news.
		expect(await store.get('s')).toEqual(stub)
		expect((await feed(store, cursor)).nodes).toEqual([])
	})

	test('an empty directory saves its sidecar, so a reopen is not a reset', async () => {
		const root = await temp()
		const one = open(root)
		const { cursor } = await feed(one)

		// Nothing changed on the first scan, but the lineage and the root row were
		// minted — and a lineage only this instance knows fences every cursor it
		// ever handed out (rule 11).
		const two = open(root)
		expect((await two.since(cursor)).nodes).toEqual([])
	})
})

/**
 * A mount is the one type POSIX cannot state: on the disk it is an empty directory
 * standing in for the store it is bound to. Two things follow, and both are the
 * boundary `authority.ts` puts the whole local-data story on — a mount holds no
 * rows of THIS store, so a `/private` subtree is impossible in the synced one.
 */
describe('fsStore: a junction is not a directory', () => {
	const junction: Node = {
		id: 'm',
		parent: ROOT,
		name: 'private',
		type: 'mount',
		mode: 0o040755,
		mtimeNs: 0n,
		size: 0n,
		version: 'v1'
	}

	/** A file row with the id the case chooses, and its bytes made durable first. */
	const file = async (store: Store, id: string, name: string, content: string): Promise<Node> => {
		const data = bytes(content)
		const hash = await sha256Hex(data)
		await store.blobs.put(hash, data)
		return {
			id,
			parent: ROOT,
			name,
			type: 'file',
			mode: 0o100644,
			mtimeNs: 0n,
			size: BigInt(data.length),
			content: hash,
			version: 'v1'
		}
	}

	test('a row under a mount is held, and nothing inside one becomes a row', async () => {
		const root = await temp()
		const store = open(root)
		await store.commit([junction])
		const inside = { ...(await file(store, 'x', 'secret.env', 'outer data')), parent: 'm' }

		// The authority refuses this row, but a replica may hold one between pages —
		// a directory re-typed to a mount before the page that moves its children out.
		// The disk must not be where that boundary leaks.
		await store.commit([inside])
		expect(await store.get('x')).toEqual(inside)
		expect(await readdir(join(root, 'private'))).toEqual([])

		// And the other direction: what a local tool puts inside a junction belongs to
		// the store bound there, so this one does not adopt it.
		await store.close?.() // no watcher: the walk is the only thing that reports
		await writeFile(join(root, 'private/leaked.txt'), 'not yours')
		await new Promise((resolve) => setTimeout(resolve, SWEEP_MS))
		await store.since()
		expect(await store.child('m', 'leaked.txt')).toBeNull()
		expect((await feed(store)).nodes.some((n) => n.name === 'leaked.txt')).toBe(false)
	}, 30_000)

	test('a mount stays a mount when the scan looks at its placeholder', async () => {
		const root = await temp()
		const store = open(root)
		await store.commit([junction])
		const { cursor } = await feed(store)

		// To POSIX this is a directory whose mode changed, and `mount` is the type it
		// cannot say — the sidecar is the only thing that knows. A re-type nobody made
		// would travel to every replica and open the junction to rows from this store.
		await chmod(join(root, 'private'), 0o700)
		await settled(store, async () => ((await store.get('m'))?.mode ?? 0) === 0o040700)

		expect((await store.get('m'))?.type).toBe('mount')
		expect(
			(await feed(store, cursor)).nodes.filter((n) => n.id === 'm' && n.type !== 'mount')
		).toEqual([])
	}, 30_000)
})

describe('fsStore: the sidecar is the store, not the tree', () => {
	test('an id is not a path: parking a row cannot reach outside the store', async () => {
		const root = await temp()
		// Beside the store, not in it: the only way to show that nothing reached it.
		const name = `victim-${crypto.randomUUID()}`
		const outside = join(root, '..', name)
		await writeFile(outside, 'not yours')
		const store = open(root)
		const data = bytes('hello')
		const hash = await sha256Hex(data)
		await store.blobs.put(hash, data)
		// An id is a peer's string. `..` is an ordinary character in one and a way out of
		// the store in a path — and the holding area is reached by interpolating the id,
		// after `park` removes whatever is at its target.
		const row: Node = {
			id: `../../../${name}`,
			parent: ROOT,
			name: 'a.txt',
			type: 'file',
			mode: 0o100644,
			mtimeNs: 0n,
			size: BigInt(data.length),
			content: hash,
			version: 'v1'
		}
		await store.commit([row])
		expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('hello')

		// Made unreachable, which is what sends a row's file to the holding area.
		await store.commit([{ ...row, parent: 'nowhere', version: 'v2' }])

		expect(await readFile(outside, 'utf8')).toBe('not yours')
		expect((await readdir(join(root, '..'))).includes(name)).toBe(true)
		// And the row still kept its bytes, wherever they were put.
		expect(read(await store.blobs.get(hash))).toBe('hello')
		await rm(outside, { force: true })
	})

	test('a name holding the path separator has no place on the disk', async () => {
		const root = await temp()
		const store = open(root)
		const data = bytes('nope')
		const hash = await sha256Hex(data)
		await store.blobs.put(hash, data)
		// `sep`, so this asks what the PLATFORM asks. On Windows a backslash separates
		// too, and a row from a peer named `..\victim` would resolve clean out of the
		// store root, while `.jfs\index.json` would reach the index reading as one name.
		const row: Node = {
			id: 'x',
			parent: ROOT,
			name: `..${sep}victim`,
			type: 'file',
			mode: 0o100644,
			mtimeNs: 0n,
			size: BigInt(data.length),
			content: hash,
			version: 'v1'
		}

		await store.commit([row])
		expect(await store.get('x')).toEqual(row)
		expect(await readdir(root)).toEqual(['.jfs'])
		expect(await readdir(join(root, '..')).then((names) => names.includes('victim'))).toBe(false)
	})

	test('a name holding NUL is a row and nothing else, and wedges no page', async () => {
		const root = await temp()
		const store = open(root)
		const data = bytes('nope')
		const hash = await sha256Hex(data)
		await store.blobs.put(hash, data)
		const row: Node = {
			id: 'n',
			parent: ROOT,
			name: 'bad\u0000name.txt',
			type: 'file',
			mode: 0o100644,
			mtimeNs: 0n,
			size: BigInt(data.length),
			content: hash,
			version: 'v1'
		}

		// NUL is the one byte a name cannot hold — every backend's composed keys say so
		// — and `node:fs` refuses a path that contains one. A page carrying such a row
		// must not be a page this replica can never apply, so the row is held exactly
		// like any other name this store cannot place.
		await store.commit([row])
		expect(await store.get('n')).toEqual(row)
		expect(await readdir(root)).toEqual(['.jfs'])
		// And the scan neither buries it nor mints a ghost: the disk never held it.
		expect((await feed(store)).nodes.filter((n) => n.deleted)).toEqual([])
	})

	test('a row that asks for the sidecar name never writes over it', async () => {
		const root = await temp()
		const store = open(root)
		const row = await place(store, 'kept.md', 'still here')

		// `.jfs` is this store's own bookkeeping. A row that claims the name is held
		// like any row the tree cannot place: readable, invisible on disk, and unable
		// to touch the index that knows what every row is.
		const bytes2 = bytes('a row where the index lives')
		const hash = await sha256Hex(bytes2)
		await store.blobs.put(hash, bytes2)
		await store.commit([
			{
				id: 'x',
				parent: ROOT,
				name: '.jfs',
				type: 'file',
				mode: 0o100644,
				mtimeNs: 0n,
				size: BigInt(bytes2.length),
				content: hash,
				version: 'v1'
			}
		])
		expect((await store.get('x'))?.name).toBe('.jfs')
		expect(await readFile(join(root, '.jfs/index.json'), 'utf8')).toContain('"lineage"')
		expect(read(await store.blobs.get(row.content ?? ''))).toBe('still here')
		// And it survives the round trip the index makes on a reopen.
		expect((await open(root).child(ROOT, 'kept.md'))?.id).toBe(row.id)
	})
})

/**
 * The watcher, and the walk behind it. The store hears about a change the OS
 * announces in milliseconds, and finds one it does not on a floor — because a
 * recursive watch drops events, so it can be the latency but never the truth.
 */
describe('fsStore: told, or else looked for', () => {
	const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

	test('a watcher makes a change visible well inside the floor', async () => {
		const root = await temp()
		const store = open(root)
		const row = await place(store, 'a.txt', 'hello')
		// The walk that just ran resets the floor, so nothing below can be a walk:
		// what arrives, arrives because the OS said so.
		const { cursor } = await feed(store)

		await writeFile(join(root, 'a.txt'), 'edited by somebody else')
		const at = Date.now()
		let seen = false
		while (!seen && Date.now() - at < SWEEP_MS - 100) {
			await store.since()
			seen = (await store.get(row.id))?.size === 23n
			if (!seen) await sleep(10)
		}
		if (!seen) throw new Error('the watcher never delivered inside the floor')
		expect((await feed(store, cursor)).nodes.map((n) => n.id)).toEqual([row.id])
	})

	test('with the watcher closed the walk carries it, on the floor', async () => {
		const root = await temp()
		const store = open(root)
		const row = await place(store, 'a.txt', 'hello')
		await feed(store)

		// The host that built this store is done with the watcher. Everything still
		// works — by looking, instead of being told.
		await store.close?.()
		await store.close?.() // idempotent: a shutdown path may run twice
		await writeFile(join(root, 'a.txt'), 'edited by somebody else')
		await settled(store, async () => (await store.get(row.id))?.size === 23n)
		const { cursor } = await feed(store)

		// A second change, and nothing to announce it: inside the floor the store
		// has not looked yet, so it says nothing rather than looking on every call.
		await writeFile(join(root, 'a.txt'), 'edited again, and longer still')
		expect((await store.since(cursor)).nodes).toEqual([])
		await sleep(SWEEP_MS)
		await settled(store, async () => (await store.get(row.id))?.size === 30n)
		expect((await feed(store, cursor)).nodes.map((n) => n.id)).toEqual([row.id])
	}, 30_000)

	test('an atomic save is a directory change, so the cheap look finds it', async () => {
		const root = await temp()
		const store = open(root)
		const row = await place(store, 'a.txt', 'hello')
		await feed(store)
		await store.close?.() // no watcher: only the walk can find this

		// What every editor does: write beside the file, then take its name. It moves
		// the DIRECTORY's mtime, which is what the cheap look reads.
		await writeFile(join(root, 'tmp'), 'saved by an editor')
		await rename(join(root, 'tmp'), join(root, 'a.txt'))
		await sleep(SWEEP_MS)
		await settled(store, async () => (await store.get(row.id))?.size === 18n)
		expect(read(await store.blobs.get((await store.get(row.id))?.content ?? ''))).toBe(
			'saved by an editor'
		)
	}, 30_000)
})
