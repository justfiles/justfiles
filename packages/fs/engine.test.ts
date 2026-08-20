/**
 * The engine, against memStores. Everything here is two `since` scans and a
 * `commit` per page, so what the tests actually pin down is the small set of
 * claims that make those two scans a sync:
 *
 * - a scan from the empty cursor is the whole bootstrap (rule 4),
 * - a row the store already holds writes nothing (rule 3), which is what makes
 *   a lost cursor, a crash, and a replayed page all cost the same: a re-scan,
 * - the author tag inside a `Version` keeps the steady state silent, so
 *   idempotence stays the safety net rather than the traffic,
 * - a cursor from a dead lineage fences the replica instead of misleading it
 *   (rule 11).
 *
 * No volume, no blobs: the engine moves rows, and it moves them for any store.
 */

import { describe, expect, it, vi } from 'vitest'
import { type CursorSlot, sync, versions } from './engine'
import { memStore } from './mem'
import { type Cursor, type Node, ROOT, type Store, type Version } from './store'

/**
 * The host-local slot the engine keeps its cursor in. A variable is the whole
 * contract — the point of the injection is that nothing engine-owned lands in
 * the replicated table or in the user's tree.
 */
function slot(start?: Cursor): CursorSlot & { clear: () => void } {
	let at = start
	return {
		load: async () => at,
		save: async (cursor) => {
			at = cursor
		},
		clear: () => {
			at = undefined
		}
	}
}

/** Two replicas and the slots between them. */
function pair(replica = 'a') {
	const pull = slot()
	const push = slot()
	return { local: memStore(), remote: memStore(), pull, push, opts: { replica, pull, push } }
}

/** A plain file row under root, authored by `mint`. */
const file = (mint: () => Version, over: Partial<Node> & Pick<Node, 'id' | 'name'>): Node => ({
	parent: ROOT,
	type: 'file',
	mode: 0o100644,
	mtimeNs: 0n,
	size: 0n,
	version: mint(),
	...over
})

/** 300 rows: more than one page on any store, so a drain has to resume. */
const many = (mint: () => Version): Node[] =>
	Array.from({ length: 300 }, (_, i) => file(mint, { id: `n${i}`, name: `f${i}.txt` }))

/**
 * Scan a feed to its end, the way the engine does. `since` always hands a cursor
 * back, so the scan is over when a page carries no rows — and that cursor is the
 * one to resume from.
 */
async function scan(store: Store, from?: Cursor): Promise<{ rows: Node[]; cursor: Cursor }> {
	const rows: Node[] = []
	let cursor = from
	for (let page = 0; page < 100; page++) {
		const got = await store.since(cursor)
		if (got.next === undefined) throw new Error('since must always hand a cursor back')
		cursor = got.next
		if (got.nodes.length === 0) return { rows, cursor }
		rows.push(...got.nodes)
	}
	throw new Error('since never caught up')
}

/** Every row a store holds, at its latest state: what the invariant compares. */
const rowsOf = async (store: Store): Promise<Node[]> =>
	(await scan(store)).rows.sort((a, b) => (a.id < b.id ? -1 : 1))

/** The commits a peer was asked to make — the push side, seen from outside. */
function spy(store: Store): { store: Store; calls: Node[][] } {
	const calls: Node[][] = []
	return {
		calls,
		store: {
			...store,
			commit(writes, guards) {
				calls.push(writes)
				return store.commit(writes, guards)
			}
		}
	}
}

/**
 * Every row a store actually WROTE from here on. A commit of rows it already
 * holds is a no-op (rule 3) and notifies nobody, so an empty list is the proof
 * that a replay changed nothing — stronger than comparing state, which a write
 * of identical rows would also pass.
 */
function written(store: Store): Node[] {
	const rows: Node[] = []
	store.subscribe?.((batch) => rows.push(...batch))
	return rows
}

describe('versions', () => {
	it('mints a string no other minter for the same replica can mint', () => {
		// Two minters for one replica is a restart, or a second volume over the same
		// store. A version is compared by equality — a guard states the one it read
		// (`volume.ts`) and rule 3 calls a row it matches a no-op — so a
		// repeat lets a stale guard pass against a row it never saw, and the
		// concurrent update it was there to catch is lost.
		const one = versions('a')
		const two = versions('a')

		const minted = Array.from({ length: 100 }, () => [one(), two()]).flat()

		expect(new Set(minted).size).toBe(minted.length)
		// Chance is the only thing separating two minters, so the nonce keeps a
		// WHOLE uuid. Trim it and the birthday bound does the rest: at 32 bits, one
		// replica in a hundred that reaches 10,000 minters has two of them counting
		// from 1 over the same strings — which is the lost update above, restored.
		expect(one()).toMatch(/^a:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}-\d+$/)
	})

	it('names the replica as the author, whatever it puts after it', () => {
		// The push filter and T7's `source` both read the author out of a version:
		// everything before the last `:`. It is the one part of the encoding that is
		// not the engine's own business.
		expect(versions('a')().lastIndexOf(':')).toBe(1)
		expect(versions('agent-7')().slice(0, 'agent-7:'.length)).toBe('agent-7:')
	})
})

describe('sync: bootstrap', () => {
	it('converges an empty replica from the empty cursor', async () => {
		const { local, remote, opts } = pair()
		await remote.commit(many(versions('b')))

		await sync(local, remote, opts)

		expect(await rowsOf(local)).toEqual(await rowsOf(remote))
	})

	it('leaves identical rows on both sides when each began with its own', async () => {
		const { local, remote, opts } = pair()
		await local.commit([file(versions('a'), { id: 'mine', name: 'mine.txt' })])
		await remote.commit([file(versions('b'), { id: 'theirs', name: 'theirs.txt' })])

		await sync(local, remote, opts)

		const rows = await rowsOf(local)
		expect(rows).toEqual(await rowsOf(remote))
		expect(rows.map((n) => n.id)).toEqual([ROOT, 'mine', 'theirs'])
	})
})

describe('sync: the push filter', () => {
	it('sends only the rows this replica authored', async () => {
		const { local, remote, opts } = pair()
		const peer = spy(remote)
		await local.commit([
			file(versions('a'), { id: 'mine', name: 'mine.txt' }),
			file(versions('c'), { id: 'theirs', name: 'theirs.txt' })
		])

		await sync(local, peer.store, opts)

		expect(peer.calls.flat().map((n) => n.id)).toEqual(['mine'])
	})

	it('never pushes a pulled row back, so the steady state is silent', async () => {
		const { local, remote, opts } = pair()
		const peer = spy(remote)
		const theirs = versions('b')
		await remote.commit([file(theirs, { id: 'one', name: 'one.txt' })])

		await sync(local, peer.store, opts)
		await remote.commit([file(theirs, { id: 'two', name: 'two.txt' })])
		await sync(local, peer.store, opts)

		expect(peer.calls).toEqual([])
		expect(await rowsOf(local)).toEqual(await rowsOf(remote))
	})
})

describe('sync: push cost', () => {
	it('commits a page without reading or guarding peer rows', async () => {
		const { local, remote, opts } = pair()
		await local.commit(many(versions('a')))
		const get = vi.fn(remote.get)
		const commit = vi.fn(remote.commit)
		const peer: Store = { ...remote, get, commit }

		await sync(local, peer, opts)

		expect(get).not.toHaveBeenCalled()
		expect(commit).toHaveBeenCalled()
		for (const call of commit.mock.calls) expect(call[1]).toBeUndefined()
		expect(await rowsOf(remote)).toEqual(await rowsOf(local))
	})
})

describe('sync: idempotence', () => {
	it('does not write back the page the push just sent', async () => {
		const { local, remote, opts } = pair()
		await local.commit([file(versions('a'), { id: 'mine', name: 'mine.txt' })])
		const me = spy(local)

		await sync(me.store, remote, opts)

		// A peer's feed carries this replica's own rows too, so the pull reads back
		// exactly what the push sent. Rule 3 makes writing it a no-op, but a store is
		// handed a batch and answers nothing, so a wrapper that wakes subscribers
		// reports the no-ops as writes — and `synced.ts` reads its own echo as local
		// work and arms another push, for ever, one spare cycle per write.
		expect(me.calls).toEqual([])
		expect(await rowsOf(local)).toEqual(await rowsOf(remote))
	})

	it('writes the rows the peer changed, and only those', async () => {
		const { local, remote, opts } = pair()
		await local.commit([file(versions('a'), { id: 'mine', name: 'mine.txt' })])
		await remote.commit([file(versions('b'), { id: 'theirs', name: 'theirs.txt' })])
		const me = spy(local)

		await sync(me.store, remote, opts)

		// The page holds the echo, the root (a constant on every store, rule 6) and one
		// row that is news. Only the last of the three is a write.
		expect(me.calls.flat().map((row) => row.id)).toEqual(['theirs'])
	})

	it('applies a page the store already holds as a no-op', async () => {
		const { local, remote } = pair()
		await remote.commit(many(versions('b')))
		const page = await remote.since()

		await local.commit(page.nodes)
		const tail = (await scan(local)).cursor
		const wrote = written(local)
		await local.commit(page.nodes)

		expect(wrote).toEqual([])
		// Nothing moved in the feed either: a no-op that still took a position
		// would hand the next push a page of rows to send.
		expect((await local.since(tail)).nodes).toEqual([])
	})

	it('re-applies every page as a no-op when the saved cursors are gone', async () => {
		const { local, remote, pull, push, opts } = pair()
		await local.commit(many(versions('a')))
		await remote.commit([file(versions('b'), { id: 'theirs', name: 'theirs.txt' })])
		await sync(local, remote, opts)
		const before = await rowsOf(local)
		const tails = { local: (await scan(local)).cursor, remote: (await scan(remote)).cursor }

		pull.clear()
		push.clear()
		const wrote = { local: written(local), remote: written(remote) }
		await sync(local, remote, opts)

		expect(wrote.local).toEqual([])
		expect(wrote.remote).toEqual([])
		expect(await rowsOf(local)).toEqual(before)
		expect((await local.since(tails.local)).nodes).toEqual([])
		expect((await remote.since(tails.remote)).nodes).toEqual([])
	})

	it('converges after a crash between a commit and its cursor save', async () => {
		const { local, remote, pull, push, opts } = pair()
		await remote.commit(many(versions('b')))
		// The cursor is saved AFTER its batch commits, so this kills the loop in
		// the one window that matters: rows landed, the cursor never moved.
		const crashing: CursorSlot = {
			load: () => pull.load(),
			save: async () => {
				throw new Error('crash')
			}
		}

		await expect(sync(local, remote, { ...opts, pull: crashing, retries: 0 })).rejects.toThrow(
			'crash'
		)

		const applied = (await rowsOf(local)).map((n) => n.id)
		expect(applied.length).toBeGreaterThan(1)
		expect(applied.length).toBeLessThan((await rowsOf(remote)).length)
		expect(await pull.load()).toBeUndefined()

		const wrote = written(local)
		await sync(local, remote, opts)

		expect(await rowsOf(local)).toEqual(await rowsOf(remote))
		// The re-run costs a re-scan of what already landed, and nothing else.
		expect(wrote.map((n) => n.id).filter((id) => applied.includes(id))).toEqual([])
		expect(await push.load()).toBeDefined()
	})
})

describe('sync: local work in flight', () => {
	it('keeps an unpushed local edit that the peer still holds in an older state', async () => {
		const { local, remote, pull, opts } = pair()
		const base = file(versions('b'), { id: 'x', name: 'x.txt', size: 1n })
		await remote.commit([base])
		await sync(local, remote, opts)

		// An edit this replica has not pushed yet, and a pull cursor that is gone —
		// a crash, a cleared slot, a fenced lineage. The peer's replayed page then
		// carries the row's OLDER state, so a pull that ran first would overwrite
		// the edit, and the push behind it would skip the row it found there,
		// because that row is now the peer's. The edit would be gone from both
		// stores, with nothing to report it. Offering it first is what closes that.
		await local.commit([{ ...base, size: 99n, version: versions('a')() }])
		pull.clear()

		await sync(local, remote, opts)

		expect(await local.get('x')).toMatchObject({ size: 99n })
		expect(await remote.get('x')).toMatchObject({ size: 99n })
	})
})

describe('sync: lineage', () => {
	it('starts again from the empty cursor when a peer fences it', async () => {
		const gone = memStore() // another lineage: its cursors mean nothing anywhere else
		const alien = (await gone.since()).next
		const local = memStore()
		const remote = memStore()
		const pull = slot(alien)
		const push = slot(alien)
		await remote.commit([file(versions('b'), { id: 'theirs', name: 'theirs.txt' })])
		await local.commit([file(versions('a'), { id: 'mine', name: 'mine.txt' })])

		await sync(local, remote, { replica: 'a', pull, push })

		expect(await rowsOf(local)).toEqual(await rowsOf(remote))
		// Both slots hold a cursor of the live lineage now, so the next cycle
		// resumes from it instead of bootstrapping again.
		const resumed = { pull: await pull.load(), push: await push.load() }
		expect(resumed.pull).toBeDefined()
		expect(resumed.push).toBeDefined()
		await expect(remote.since(resumed.pull)).resolves.toBeDefined()
		await expect(local.since(resumed.push)).resolves.toBeDefined()
	})

	it('restores what it authored to a peer that was replaced', async () => {
		const local = memStore()
		const first = memStore()
		const pull = slot()
		const push = slot()
		const opts = { replica: 'a', pull, push }
		await local.commit([file(versions('a'), { id: 'mine', name: 'mine.txt' })])
		await first.commit([file(versions('b'), { id: 'theirs', name: 'theirs.txt' })])
		await sync(local, first, opts)

		// The peer is reset: a new store, a new lineage, and not one row of ours.
		// Only the PULL cursor is fenced — the push cursor names a position in the
		// local feed, which is untouched, and it says "already sent" about rows this
		// peer has never seen.
		const replacement = memStore()
		await sync(local, replacement, opts)

		expect(await replacement.child(ROOT, 'mine.txt')).toMatchObject({ id: 'mine' })
		// And the row it merely HOLDS stays behind. The push filter is the author
		// tag, in a bootstrap exactly as in the steady state: a replica restores its
		// own work to a reset peer, and is not a silent backup of everyone else's —
		// which would let one stale replica re-seed a fresh authority with a view
		// nobody chose. Re-seeding wholesale is a decision, and it has a name:
		// T11's `takeMine`, which re-authors every local row first.
		expect(await replacement.child(ROOT, 'theirs.txt')).toBeNull()
	})

	it('takes the whole peer history when its own store was replaced', async () => {
		const remote = memStore()
		const pull = slot()
		const push = slot()
		const opts = { replica: 'a', pull, push }
		await remote.commit([file(versions('b'), { id: 'theirs', name: 'theirs.txt' })])
		await sync(memStore(), remote, opts)

		// The mirror image, which is `takeTheirs` in T11: this replica is the one
		// replaced. Now the PUSH cursor is the fenced one, and the pull cursor is
		// still good — it claims rows the new store has never held.
		const replacement = memStore()
		await sync(replacement, remote, opts)

		expect(await rowsOf(replacement)).toEqual(await rowsOf(remote))
	})
})

describe('sync: topology', () => {
	it('carries a write from one replica to another through a hub', async () => {
		const hub = memStore()
		const a = { store: memStore(), replica: 'a', pull: slot(), push: slot() }
		const b = { store: memStore(), replica: 'b', pull: slot(), push: slot() }
		await a.store.commit([file(versions('a'), { id: 'mine', name: 'mine.txt' })])

		await sync(a.store, hub, a)
		await sync(b.store, hub, b)

		expect(await b.store.child(ROOT, 'mine.txt')).toMatchObject({ id: 'mine' })

		// And back the other way, through the same hub.
		await b.store.commit([file(versions('b'), { id: 'theirs', name: 'theirs.txt' })])
		await sync(b.store, hub, b)
		await sync(a.store, hub, a)

		expect(await rowsOf(a.store)).toEqual(await rowsOf(b.store))
	})
})

describe('sync: retries', () => {
	it('retries a peer that fails, backing off between attempts', async () => {
		vi.useFakeTimers()
		try {
			const { local, remote, opts } = pair()
			await remote.commit([file(versions('b'), { id: 'theirs', name: 'theirs.txt' })])
			let failures = 2
			const flaky: Store = {
				...remote,
				since: (cursor) =>
					failures-- > 0 ? Promise.reject(new Error('offline')) : remote.since(cursor)
			}

			const started = Date.now()
			const done = sync(local, flaky, { ...opts, backoffMs: 1000 })
			await vi.runAllTimersAsync()
			await done

			// It waited, and it waited longer the second time.
			expect(Date.now() - started).toBe(3000)
			expect(await rowsOf(local)).toEqual(await rowsOf(remote))
		} finally {
			vi.useRealTimers()
		}
	})

	it('spends no part of the retry budget on a lineage rewind', async () => {
		vi.useFakeTimers()
		try {
			const local = memStore()
			const remote = memStore()
			await remote.commit([file(versions('b'), { id: 'theirs', name: 'theirs.txt' })])
			// Fenced first, then one transient failure. A rewind is not a failure, so
			// the replacement peer is owed the same attempts as the one it replaced.
			const alien = (await memStore().since()).next
			let offline = 1
			const flaky: Store = {
				...remote,
				since: (cursor) =>
					cursor === undefined && offline-- > 0
						? Promise.reject(new Error('offline'))
						: remote.since(cursor)
			}

			const done = sync(local, flaky, {
				replica: 'a',
				pull: slot(alien),
				push: slot(),
				retries: 1,
				backoffMs: 10
			})
			await vi.runAllTimersAsync()
			await done

			expect(await rowsOf(local)).toEqual(await rowsOf(remote))
		} finally {
			vi.useRealTimers()
		}
	})

	it('gives up after its retries and reports what failed', async () => {
		vi.useFakeTimers()
		try {
			const { local, remote, opts } = pair()
			const dead: Store = { ...remote, since: () => Promise.reject(new Error('offline')) }

			const done = sync(local, dead, { ...opts, retries: 1, backoffMs: 10 }).catch((e) => e)
			await vi.runAllTimersAsync()

			expect(await done).toMatchObject({ message: 'offline' })
		} finally {
			vi.useRealTimers()
		}
	})
})
