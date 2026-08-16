/**
 * Contract rule 9, from both ends.
 *
 * The tree invariants — no cycles, no duplicate names, every parent a live
 * directory — belong to ONE store's `commit`, and the same rows a plain store
 * takes without a word are what the authority refuses. That difference IS the
 * rule, so it is asserted directly: every rejection here is paired with a plain
 * `memStore`, holding the same rows, taking the very same batch.
 *
 * The other half of rule 9 is why a replica is allowed to be so relaxed:
 * visibility is reachability from root, so a detached cluster is invisible to
 * the POSIX view until a later row reattaches it. No cleanup, no repair pass.
 */

import { describe, expect, it } from 'vitest'
import { authority } from './authority'
import { GuardError, type Node, ROOT } from './store'
import { memStore } from './store.mem'
import { storeVolume } from './volume.store'

const enc = new TextEncoder()

/** A plain file row under root. Only what a case cares about is spelled out. */
const file = (over: Partial<Node> & Pick<Node, 'id' | 'name'>): Node => ({
	parent: ROOT,
	type: 'file',
	mode: 0o100644,
	mtimeNs: 0n,
	size: 0n,
	version: '1',
	...over
})

const dir = (over: Partial<Node> & Pick<Node, 'id' | 'name'>): Node =>
	file({ type: 'dir', mode: 0o040755, ...over })

/** A store, the authority over it, and a plain twin holding the same rows. */
function hub() {
	const store = memStore()
	const plain = memStore()
	const server = authority(store)
	return {
		store,
		server,
		/** Both stores take these, so the twin differs by rule 9 and nothing else. */
		seed: async (...rows: Node[]): Promise<void> => {
			await store.commit(rows)
			await plain.commit(rows)
		},
		/**
		 * The rule as one assertion. Rule 9 is not "these rows are invalid" — it is
		 * "one store decides", and a replica holding them mid-sync is behaving.
		 */
		refused: async (writes: Node[]): Promise<Error> => {
			const error = await server.commit(writes).then(
				() => null,
				(e: unknown) => e
			)
			expect(error).toBeInstanceOf(GuardError)
			await expect(plain.commit(writes)).resolves.toBeUndefined()
			return error as Error
		}
	}
}

describe('authority: the tree invariants', () => {
	it('refuses a second live row for one name', async () => {
		const { store, seed, refused } = hub()
		await seed(file({ id: 'first', name: 'note.txt' }))

		const error = await refused([file({ id: 'second', name: 'note.txt' })])

		expect(error.message).toMatch(/note\.txt/)
		// Rule 1 is what makes the twin's acceptance safe: two live rows for one
		// name resolve to the lowest id on EVERY replica, so replicas agree on what
		// is visible even while they converge.
		expect(await store.child(ROOT, 'note.txt')).toMatchObject({ id: 'first' })
	})

	it('refuses two rows in one batch that claim one name', async () => {
		const { refused } = hub()

		await refused([file({ id: 'one', name: 'note.txt' }), file({ id: 'two', name: 'note.txt' })])
	})

	it('takes a rename that gives a name away and takes it back in one commit', async () => {
		// The name is held at read time and free at write time, because the batch
		// vacates it. Checking each row against the store alone would refuse the one
		// commit POSIX rename is built on.
		const { server, seed } = hub()
		await seed(file({ id: 'keep', name: 'new.txt' }), file({ id: 'displaced', name: 'old.txt' }))

		await expect(
			server.commit([
				{ ...file({ id: 'displaced', name: 'old.txt' }), deleted: true, version: '2' },
				file({ id: 'keep', name: 'old.txt', version: '2' })
			])
		).resolves.toBeUndefined()
	})

	it('refuses a parent that is a live file', async () => {
		const { seed, refused } = hub()
		await seed(file({ id: 'notadir', name: 'note.txt' }))

		const error = await refused([file({ id: 'child', name: 'inside.txt', parent: 'notadir' })])

		expect(error.message).toMatch(/live directory/)
	})

	it('refuses a parent that is a tombstone', async () => {
		const { seed, refused } = hub()
		const gone = dir({ id: 'gone', name: 'gone' })
		await seed(gone)
		await seed({ ...gone, deleted: true, version: '2' })

		await refused([file({ id: 'child', name: 'inside.txt', parent: 'gone' })])
	})

	it('takes a row whose parent has not arrived yet', async () => {
		// Detached, and allowed. It has to be: the feed puts a directory AFTER the
		// child whose creation stamped it, so a paged push routinely offers children
		// first — refusing them would need the parents-before-children wire ordering
		// this model exists to delete. Rule 9 makes it safe, because nothing reaches
		// a detached row from the root until the page carrying its parent lands.
		const { server } = hub()

		await expect(
			server.commit([file({ id: 'child', name: 'inside.txt', parent: 'later' })])
		).resolves.toBeUndefined()
	})

	it('refuses a move that puts a directory under its own descendant', async () => {
		const { seed, refused } = hub()
		await seed(dir({ id: 'top', name: 'top' }), dir({ id: 'inner', name: 'inner', parent: 'top' }))

		const error = await refused([dir({ id: 'top', name: 'top', parent: 'inner', version: '2' })])

		expect(error.message).toMatch(/ancestor/)
	})

	it('refuses a cycle built out of rows nobody can see', async () => {
		// Two new rows pointing at each other reach the root from nowhere, so no
		// replica would ever show them. Refused anyway: what a replica may hold
		// transiently, the authority may not make permanent.
		const { refused } = hub()

		await refused([
			dir({ id: 'one', name: 'one', parent: 'two' }),
			dir({ id: 'two', name: 'two', parent: 'one' })
		])
	})

	it('refuses to bring a tombstoned id back to life', async () => {
		const { seed, refused } = hub()
		const note = file({ id: 'note', name: 'note.txt' })
		await seed(note)
		await seed({ ...note, deleted: true, version: '2' })

		const error = await refused([{ ...note, version: '3' }])

		// Rule 8: a tombstone keeps its id, its version and the fact that it is gone.
		// That is what tells a create on one replica apart from a delete on another —
		// the distinction Unison needs a common base for.
		expect(error.message).toMatch(/deleted/)
	})

	it('serializes its commits, so two claims on one name cannot both pass', async () => {
		// Every check here reads the store and then writes, and a queue of one is
		// what makes those two a single step. Without it both claims read a free
		// name and both land.
		const { store, server } = hub()

		const results = await Promise.allSettled([
			server.commit([file({ id: 'one', name: 'note.txt' })]),
			server.commit([file({ id: 'two', name: 'note.txt' })])
		])

		expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected'])
		expect((await store.since()).nodes.filter((n) => n.name === 'note.txt')).toHaveLength(1)
	})
})

describe('authority: what it leaves alone', () => {
	it("rejects the caller's own version guard, unchanged", async () => {
		const { server, seed } = hub()
		const note = file({ id: 'note', name: 'note.txt' })
		await seed(note)

		await expect(
			server.commit([{ ...note, size: 9n, version: '2' }], [{ version: { id: 'note', is: 'old' } }])
		).rejects.toBeInstanceOf(GuardError)
		await expect(
			server.commit([{ ...note, size: 9n, version: '2' }], [{ version: { id: 'note', is: '1' } }])
		).resolves.toBeUndefined()
	})

	it('verifies bytes against the hash that named them', async () => {
		// Rule 7: this is the store that takes writes from peers, so it is the one
		// that cannot take a caller's word for what its bytes hash to. The engine's
		// push transfers unverified for exactly this reason.
		const { store, server } = hub()

		await expect(server.blobs.put('not-the-hash', enc.encode('hello'))).rejects.toThrow(
			/do not hash/
		)
		expect(await store.blobs.has('not-the-hash')).toBe(false)
	})

	it('leaves every other seam call to the store it wraps', async () => {
		const { store, server, seed } = hub()
		await seed(file({ id: 'note', name: 'note.txt' }))

		expect(await server.get('note')).toEqual(await store.get('note'))
		expect(await server.child(ROOT, 'note.txt')).toMatchObject({ id: 'note' })
		expect((await server.children(ROOT)).nodes).toHaveLength(1)
		expect((await server.since()).nodes).toHaveLength(2)
	})
})

describe('a detached cluster on a replica', () => {
	it('is invisible to path resolution until a later row reattaches it', async () => {
		// The replica's half of rule 9, and the reason the invariants live in one
		// place: a replica needs no repair pass, because a row the root cannot reach
		// is not in the tree.
		const store = memStore()
		const vol = storeVolume(store)
		await store.commit([
			dir({ id: 'orphan', name: 'orphan', parent: 'ghost' }),
			file({ id: 'buried', name: 'buried.txt', parent: 'orphan' })
		])

		expect(await vol.readdir('/')).toEqual([])
		await expect(vol.stat('/orphan')).rejects.toThrow('ENOENT')
		await expect(vol.stat('/orphan/buried.txt')).rejects.toThrow('ENOENT')

		await store.commit([dir({ id: 'ghost', name: 'ghost' })])

		expect((await vol.readdir('/')).map((e) => e.name)).toEqual(['ghost'])
		expect(await vol.stat('/ghost/orphan/buried.txt')).toMatchObject({ ino: 'buried' })
	})
})
