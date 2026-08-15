/**
 * The `Store` conformance suite. Every backend runs the same behavior tests —
 * there is no capability negotiation: the contract is the contract.
 *
 * Rule numbers cite `kb/fs/fable-design.md` #3 "Contract". This file covers
 * rules 1 to 6, 8 and 11. Blobs (rules 7, 10) are added by a later task.
 */

import { describe, expect, test } from 'vitest'
import { type Cursor, ForeignCursorError, type Node, type NodeId, ROOT, type Store } from './store'

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)

/** A plain file row under root. Only what a case cares about is spelled out. */
const node = (over: Partial<Node> & Pick<Node, 'id' | 'name'>): Node => ({
	parent: ROOT,
	type: 'file',
	mode: 0o100644,
	mtimeNs: 0n,
	size: 0n,
	version: '1',
	...over
})

/** Page through `children` to the end. The cursor starts a resumed listing. */
async function drain(store: Store, parent: NodeId, cursor?: Cursor): Promise<Node[]> {
	const out: Node[] = []
	for (let page = 0; page < 1000; page++) {
		const { nodes, next } = await store.children(parent, cursor)
		out.push(...nodes)
		if (!next) return out
		cursor = next
	}
	throw new Error('children never reached the end of the listing')
}

const names = (nodes: Node[]): string[] => nodes.map((n) => n.name)

/**
 * Scan the feed to its end. `since` always hands a cursor back, so the scan is
 * over when a page carries no nodes — that cursor is the one to resume from.
 */
async function feed(store: Store, from?: Cursor): Promise<{ nodes: Node[]; cursor: Cursor }> {
	const nodes: Node[] = []
	let cursor = from
	for (let page = 0; page < 1000; page++) {
		const got = await store.since(cursor)
		if (got.next === undefined) throw new Error('since must always hand a cursor back')
		cursor = got.next
		if (got.nodes.length === 0) return { nodes, cursor }
		nodes.push(...got.nodes)
	}
	throw new Error('since never caught up')
}

/** 300 sibling files — enough that a store with a modest page size must page. */
const many = (): Node[] =>
	Array.from({ length: 300 }, (_, i) => node({ id: `n${i}`, name: `f${i}.txt` }))

export function storeConformance(name: string, open: () => Promise<Store>): void {
	describe(`Store conformance: ${name}`, () => {
		test('get(ROOT) returns a live directory (rule 6)', async () => {
			const store = await open()
			const root = await store.get(ROOT)
			expect(root?.id).toBe(ROOT)
			expect(root?.type).toBe('dir')
			expect(root?.deleted).toBeUndefined()
		})

		test('get, child and children are two indexes over one table (rule 1)', async () => {
			const store = await open()
			const file = node({ id: 'f', name: 'a.txt' })
			const dir = node({ id: 'd', name: 'sub', type: 'dir', mode: 0o040755 })
			const inner = node({ id: 'i', name: 'deep.txt', parent: 'd' })
			await store.commit([file, dir, inner])

			// The same row, reached by either index.
			expect(await store.get('f')).toEqual(file)
			expect(await store.child(ROOT, 'a.txt')).toEqual(file)
			expect(await store.child('d', 'deep.txt')).toEqual(inner)
			expect(await store.get('missing')).toBeNull()
			expect(await store.child(ROOT, 'missing')).toBeNull()
			// A child belongs to its parent only.
			expect(names(await drain(store, ROOT))).toEqual(['a.txt', 'sub'])
			expect(names(await drain(store, 'd'))).toEqual(['deep.txt'])
		})

		test('children pages in one stable name order; a resumed cursor never skips or repeats (rule 1)', async () => {
			const store = await open()
			const sorted = Array.from({ length: 300 }, (_, i) => `f${String(i).padStart(3, '0')}.txt`)
			// Written back to front: the listing order comes from the name, not the write order.
			const written = [...sorted].reverse()
			await store.commit(written.map((name, i) => node({ id: `n${i}`, name })))

			expect(names(await drain(store, ROOT))).toEqual(sorted)

			const first = await store.children(ROOT)
			if (first.next) {
				const rest = await drain(store, ROOT, first.next)
				expect(names([...first.nodes, ...rest])).toEqual(sorted)
			}
		})

		test('two live rows for one (parent, name) resolve to the lowest id (rule 1)', async () => {
			const low = node({ id: 'aaa', name: 'dup.txt' })
			const high = node({ id: 'zzz', name: 'dup.txt' })
			// The id decides the winner, not the arrival order — so every replica agrees.
			const late = await open()
			await late.commit([high])
			await late.commit([low])
			expect(await late.child(ROOT, 'dup.txt')).toEqual(low)

			const early = await open()
			await early.commit([low])
			await early.commit([high])
			expect(await early.child(ROOT, 'dup.txt')).toEqual(low)

			// `children` lists the same winner `child` resolves: one entry per name, so a
			// listing can never disagree with a path lookup or hand out a duplicate name.
			expect(await drain(late, ROOT)).toEqual([low])
			expect(await drain(early, ROOT)).toEqual([low])
		})

		test('commit is atomic: a failed guard commits nothing, even as the last guard (rule 2)', async () => {
			const store = await open()
			await store.commit([node({ id: 'held', name: 'taken.txt' })])
			const a = node({ id: 'a', name: 'a.txt' })
			const b = node({ id: 'b', name: 'b.txt' })

			await expect(
				store.commit(
					[a, b],
					[
						{ free: { parent: ROOT, name: 'a.txt' } },
						{ version: { id: 'b', is: null } },
						{ free: { parent: ROOT, name: 'taken.txt' } } // fails, and it is last
					]
				)
			).rejects.toThrow()

			expect(await store.get('a')).toBeNull()
			expect(await store.get('b')).toBeNull()
			expect(names(await drain(store, ROOT))).toEqual(['taken.txt'])
		})

		test('free guards reject a held name; version guards are a CAS (rule 2)', async () => {
			const store = await open()
			const one = node({ id: 'one', name: 'one.txt', version: 'v1' })
			// `is: null` means "must not exist".
			await store.commit([one], [{ version: { id: 'one', is: null } }])
			await expect(store.commit([one], [{ version: { id: 'one', is: null } }])).rejects.toThrow()

			const other = node({ id: 'other', name: 'one.txt' })
			await expect(
				store.commit([other], [{ free: { parent: ROOT, name: 'one.txt' } }])
			).rejects.toThrow()
			expect(await store.get('other')).toBeNull()

			const two: Node = { ...one, version: 'v2', size: 9n }
			await expect(store.commit([two], [{ version: { id: 'one', is: 'stale' } }])).rejects.toThrow()
			await store.commit([two], [{ version: { id: 'one', is: 'v1' } }])
			expect(await store.get('one')).toEqual(two)

			const free = node({ id: 'free', name: 'free.txt' })
			await store.commit([free], [{ free: { parent: ROOT, name: 'free.txt' } }])
			expect(await store.child(ROOT, 'free.txt')).toEqual(free)
		})

		test('writes replace whole rows; an identical row is a no-op (rule 3)', async () => {
			const store = await open()
			const rich = node({
				id: 'r',
				name: 'r.txt',
				content: 'f'.repeat(64),
				xattrs: { tag: bytes('keep') },
				size: 4n
			})
			await store.commit([rich])
			const mark = (await store.since()).next
			await store.commit([rich])
			expect(await store.get('r')).toEqual(rich)
			expect(names(await drain(store, ROOT))).toEqual(['r.txt'])
			// A row the store already holds adds nothing to the order, so a retry or a
			// lost-cursor recovery cannot manufacture change-feed traffic. `since` is only
			// the instrument here; its own rules (4, 5, 11) are tested below.
			expect((await store.since(mark)).nodes).toEqual([])

			// Whole-row replace: the fields the new row omits are gone, not merged.
			const plain = node({ id: 'r', name: 'moved.txt', version: '2' })
			await store.commit([plain])
			expect(await store.get('r')).toEqual(plain)
			expect(await store.child(ROOT, 'r.txt')).toBeNull()
			expect(await store.child(ROOT, 'moved.txt')).toEqual(plain)
		})

		test('rows cross the boundary by value, never by reference (rule 3)', async () => {
			const store = await open()
			const held = () =>
				node({ id: 'v', name: 'v.txt', version: 'v1', xattrs: { tag: bytes('keep') } })

			// Mutating a row after committing it must not reach into the table.
			const written = held()
			await store.commit([written])
			written.name = 'tampered.txt'
			written.version = 'tampered'
			written.xattrs = { tag: bytes('tampered') }
			expect(await store.get('v')).toEqual(held())
			expect(await store.child(ROOT, 'v.txt')).toEqual(held())

			// Nor may mutating a row the store handed back.
			const read = await store.get('v')
			expect(read).not.toBeNull()
			if (read) {
				read.version = 'tampered'
				read.xattrs = { tag: bytes('tampered') }
			}
			expect(await store.get('v')).toEqual(held())

			// So read-modify-write stays a real write: the guard still sees the old
			// version, and the edit is not mistaken for the identical row it came from.
			const edit = await store.get('v')
			if (!edit) throw new Error('the row went missing')
			edit.size = 9n
			edit.version = 'v2'
			const mark = (await store.since()).next
			await store.commit([edit], [{ version: { id: 'v', is: 'v1' } }])
			expect(await store.get('v')).toEqual(edit)
			expect((await store.since(mark)).nodes.map((n) => n.id)).toEqual(['v'])
		})

		test('a tombstone frees the name and vanishes from child and children (rule 3)', async () => {
			const store = await open()
			const live = node({ id: 'x', name: 'gone.txt', version: 'v1' })
			await store.commit([live])
			await store.commit([{ ...live, version: 'v2', deleted: true }])

			expect(await store.child(ROOT, 'gone.txt')).toBeNull()
			expect(names(await drain(store, ROOT))).toEqual([])
			// The row survives: an id is never rebound, so a version guard still sees it.
			expect((await store.get('x'))?.deleted).toBe(true)
			await expect(
				store.commit([node({ id: 'z', name: 'gone.txt' })], [{ version: { id: 'x', is: null } }])
			).rejects.toThrow()

			// The name is free again.
			const reuse = node({ id: 'y', name: 'gone.txt' })
			await store.commit([reuse], [{ free: { parent: ROOT, name: 'gone.txt' } }])
			expect(await store.child(ROOT, 'gone.txt')).toEqual(reuse)
		})

		test('since from the empty cursor scans every live row and every tombstone (rule 4)', async () => {
			const store = await open()
			const rows = many()
			await store.commit(rows)
			await store.commit([node({ id: 'n7', name: 'f7.txt', version: '2', deleted: true })])

			const { nodes } = await feed(store)
			// Root travels like any other row: the feed is an index over the one
			// table, and no row is exempt from it.
			expect(new Set(nodes.map((n) => n.id))).toEqual(new Set([ROOT, ...rows.map((r) => r.id)]))
			expect(nodes.length).toBe(rows.length + 1)
			// A tombstone is a row, so a deletion travels like any other change.
			expect(nodes.find((n) => n.id === 'n7')?.deleted).toBe(true)

			// Each store picks its own page size — the contract fixes none — so what
			// has to hold is that the pages compose: a page's cursor resumes exactly
			// where that page stopped, and the pages are the scan.
			const first = await store.since()
			expect(first.nodes.length).toBeGreaterThan(0)
			if (!first.next) throw new Error('since must always hand a cursor back')
			const rest = await feed(store, first.next)
			expect([...first.nodes, ...rest.nodes]).toEqual(nodes)
		})

		test('a node appears once per scan, at its latest state: the feed self-compacts (rule 4)', async () => {
			const store = await open()
			const one = node({ id: 'a', name: 'a.txt', version: '1' })
			await store.commit([one])
			await store.commit([{ ...one, version: '2', size: 9n }])
			const latest = { ...one, name: 'moved.txt', version: '3', size: 12n }
			await store.commit([latest])

			// Three commits, one row in the feed. Nothing grows behind it.
			const { nodes } = await feed(store)
			expect(nodes.map((n) => n.id)).toEqual([ROOT, 'a'])
			expect(nodes.filter((n) => n.id === 'a')).toEqual([latest])
		})

		test('an update moves a node to the end, so a resumed cursor sees it again (rule 4)', async () => {
			const store = await open()
			const a = node({ id: 'a', name: 'a.txt', version: '1' })
			await store.commit([a, node({ id: 'b', name: 'b.txt' })])
			const caught = await feed(store)
			expect(caught.nodes.map((n) => n.id)).toEqual([ROOT, 'a', 'b'])

			const edited = { ...a, name: 'a2.txt', version: '2' }
			await store.commit([edited])
			// The resumed cursor sees `a` a second time, with its newer state — the
			// price of never permanently missing a node.
			const again = await feed(store, caught.cursor)
			expect(again.nodes).toEqual([edited])

			// And only while there is news: a caught-up cursor stays quiet.
			expect((await feed(store, again.cursor)).nodes).toEqual([])
		})

		test('a commit during a paged scan comes back later in the same scan (rule 4)', async () => {
			const store = await open()
			const rows = many()
			await store.commit(rows)

			const first = await store.since()
			if (!first.next) throw new Error('since must always hand a cursor back')
			// A row the first page already handed out changes mid-scan. The scanner
			// has no way to know, so the feed must bring it round again.
			const early = first.nodes.find((n) => n.id !== ROOT)
			if (!early) throw new Error('the first page carried no rows')
			const edited = { ...early, version: '2', size: 9n }
			await store.commit([edited])

			const rest = await feed(store, first.next)
			const seen = new Map([...first.nodes, ...rest.nodes].map((n) => [n.id, n]))
			expect(seen.size).toBe(rows.length + 1)
			expect(seen.get(edited.id)).toEqual(edited)
		})

		test('a cursor is private to its store: a foreign lineage is rejected (rules 5, 11)', async () => {
			const one = await open()
			const two = await open()
			await one.commit([node({ id: 'a', name: 'a.txt' })])
			const { cursor } = await feed(one)
			await two.commit([node({ id: 'b', name: 'b.txt' })])

			// A reset or replaced store starts a new lineage, which fences the stale
			// replica instead of silently handing it a position it never reached.
			await expect(two.since(cursor)).rejects.toThrow(ForeignCursorError)
			// The caller restarts from the empty cursor and converges.
			expect((await feed(two)).nodes.map((n) => n.id)).toEqual([ROOT, 'b'])
			// The cursor still means what it always meant to the store that minted it.
			expect((await feed(one, cursor)).nodes).toEqual([])
		})

		test('subscribe fires once per commit, after it, with the rows it wrote (rule 8)', async () => {
			const store = await open()
			if (!store.subscribe) return // optional: everything works by polling `since`

			const fired: Node[][] = []
			const reads: Promise<Node | null>[] = []
			const stop = store.subscribe((rows) => {
				fired.push(rows)
				// The writes already landed, so these reads see them.
				reads.push(...rows.map((row) => store.get(row.id)))
			})

			const a = node({ id: 'a', name: 'a.txt', version: '1' })
			const b = node({ id: 'b', name: 'b.txt' })
			await store.commit([a, b])
			expect(fired.map((rows) => rows.map((n) => n.id))).toEqual([['a', 'b']])
			expect(await Promise.all(reads)).toEqual([a, b])

			// A rejected commit wrote nothing, so it tells no one (rule 2).
			await expect(
				store.commit(
					[node({ id: 'c', name: 'c.txt' })],
					[{ free: { parent: ROOT, name: 'a.txt' } }]
				)
			).rejects.toThrow()
			// Nor does a row the store already holds — that is no change (rule 3).
			await store.commit([a])
			expect(fired.length).toBe(1)

			stop()
			await store.commit([node({ id: 'd', name: 'd.txt' })])
			expect(fired.length).toBe(1)

			// A listener is a notification, never a step in the commit: one that
			// throws must not fail a write that already landed — the caller would
			// retry a commit that succeeded — nor starve the listener behind it.
			const quiet: Node[][] = []
			store.subscribe(() => {
				throw new Error('this listener is broken')
			})
			store.subscribe((rows) => {
				quiet.push(rows)
			})
			await store.commit([node({ id: 'e', name: 'e.txt' })])
			expect(quiet.map((rows) => rows.map((n) => n.id))).toEqual([['e']])
		})
	})
}
