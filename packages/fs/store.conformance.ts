/**
 * The `Store` conformance suite. Every backend runs the same behavior tests —
 * there is no capability negotiation: the contract is the contract.
 *
 * Rule numbers cite `kb/fs/fable-design.md` #3 "Contract". This file covers
 * rules 1, 2, 3 and 6. The feed (rules 4, 5, 11) and blobs (rules 7, 10) are
 * added by later tasks.
 */

import { describe, expect, test } from 'vitest'
import { type Cursor, type Node, type NodeId, ROOT, type Store } from './store'

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

		test('child with two live rows for one (parent, name) returns the lowest id (rule 1)', async () => {
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
			await store.commit([rich])
			// The feed-level no-op is proven in T2; here the table must be unchanged.
			expect(await store.get('r')).toEqual(rich)
			expect(names(await drain(store, ROOT))).toEqual(['r.txt'])

			// Whole-row replace: the fields the new row omits are gone, not merged.
			const plain = node({ id: 'r', name: 'moved.txt', version: '2' })
			await store.commit([plain])
			expect(await store.get('r')).toEqual(plain)
			expect(await store.child(ROOT, 'r.txt')).toBeNull()
			expect(await store.child(ROOT, 'moved.txt')).toEqual(plain)
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
	})
}
