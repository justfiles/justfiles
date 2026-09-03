/**
 * `fake-indexeddb/auto` MUST be imported FIRST — before `idb.ts` and before
 * anything else that touches IDB. It installs `indexedDB`, `IDBKeyRange` and
 * `IDBDatabase` as globals, and a module that reads one of them at load time
 * captures whatever is there at that moment (see the header of
 * `storage.idb.dirty.test.ts` for where that already bit).
 *
 * This file holds the design's kill criterion. IndexedDB is the ONE structural
 * risk in the store model: a transaction stays alive only while IDB requests
 * keep it alive, so any `await` of non-IDB work inside one commits it early and
 * splits a batch in two. If a guarded batch cannot commit atomically under
 * those rules, the seam — `commit(writes, guards)` — is wrong, and no
 * workaround belongs here.
 */

import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { storeConformance } from './conformance'
import { acquireStoreOwner, idbStore } from './idb'
import { type Guard, type Node, ROOT } from './store'

afterEach(() => vi.unstubAllGlobals())

/** A fresh database per store, so two `open()` calls are two lineages. */
const fresh = () => idbStore(`t04-${crypto.randomUUID()}`)

const node = (over: Partial<Node> & Pick<Node, 'id' | 'name'>): Node => ({
	parent: ROOT,
	type: 'file',
	mode: 0o100644,
	mtimeNs: 0n,
	size: 0n,
	version: '1',
	...over
})

/** 100 siblings — the batch the kill criterion is written in terms of. */
const batch = (): Node[] =>
	Array.from({ length: 100 }, (_, i) => node({ id: `n${i}`, name: `f${i}.txt` }))

/** Every row must be new: guards that pass, and enough of them to matter. */
const fresh100 = (rows: Node[]): Guard[] =>
	rows.map((row) => ({ version: { id: row.id, is: null } }))

storeConformance('idbStore', async () => fresh())

test('only one tab owns a store namespace at a time', async () => {
	const tails = new Map<string, Promise<unknown>>()
	vi.stubGlobal('navigator', {
		locks: {
			request: (name: string, body: () => Promise<unknown>) => {
				const run = (tails.get(name) ?? Promise.resolve()).then(body)
				tails.set(
					name,
					run.catch(() => undefined)
				)
				return run
			}
		}
	})

	const releaseFirst = await acquireStoreOwner('one-store')
	let secondOwns = false
	const second = acquireStoreOwner('one-store').then((release) => {
		secondOwns = true
		return release
	})
	await Promise.resolve()
	expect(secondOwns).toBe(false)

	releaseFirst()
	const releaseSecond = await second
	expect(secondOwns).toBe(true)
	releaseSecond()
})

describe('idbStore: guarded atomic batches inside IDB transaction rules', () => {
	test('all guards and all writes land in ONE readwrite transaction', async () => {
		const store = fresh()
		// Opens the database and bootstraps root, so only the commit under test
		// is counted below.
		await store.commit([node({ id: 'held', name: 'taken.txt' })])

		type Open = typeof IDBDatabase.prototype.transaction
		const opened: { stores: string[]; mode: IDBTransactionMode }[] = []
		const original: Open = IDBDatabase.prototype.transaction
		const spy: Open = function (this: IDBDatabase, stores, mode, options) {
			opened.push({
				stores: typeof stores === 'string' ? [stores] : [...stores],
				mode: mode ?? 'readonly'
			})
			return original.call(this, stores, mode, options)
		}
		IDBDatabase.prototype.transaction = spy
		try {
			const rows = batch()
			await store.commit(rows, [
				...fresh100(rows),
				{ free: { parent: ROOT, name: 'free.txt' } },
				{ version: { id: 'held', is: '1' } }
			])
		} finally {
			IDBDatabase.prototype.transaction = original
		}

		// One transaction for 102 guards and 100 writes. Guards evaluated in a
		// transaction the writes do not share would be a race, not a guard: the
		// state they passed against can change before the writes land.
		expect(opened).toEqual([{ stores: ['nodes'], mode: 'readwrite' }])
		// And it stayed alive to the end. A non-IDB `await` inside would have
		// committed it early, and the requests after that point would throw
		// `TransactionInactiveError`.
		expect((await store.get('n99'))?.name).toBe('f99.txt')
	})

	test('a failed guard in a 100-row batch commits zero rows, seen by a reopened database', async () => {
		const name = `t04-${crypto.randomUUID()}`
		const store = idbStore(name)
		await store.commit([node({ id: 'held', name: 'taken.txt' })])

		const rows = batch()
		await expect(
			store.commit(rows, [
				...fresh100(rows),
				{ free: { parent: ROOT, name: 'taken.txt' } } // fails, and it is last
			])
		).rejects.toThrow()

		// Counted through a SECOND connection to the same database: what survives
		// is what the transaction committed, never what one connection kept in
		// memory.
		const reopened = idbStore(name)
		expect((await reopened.since()).nodes.map((n) => n.id).sort()).toEqual([ROOT, 'held'].sort())

		// The positive control, so "zero rows" means the guard and not a batch
		// this backend simply cannot write: the same 100 rows, guards that pass.
		await store.commit(rows, fresh100(rows))
		const after = idbStore(name)
		expect((await after.since()).nodes.length).toBe(rows.length + 2)
		expect((await after.get('n99'))?.name).toBe('f99.txt')
	})

	// A browser takes a transaction away on its own — storage pressure, a closed
	// tab — and it can do so at two different moments. Both must fail the whole
	// batch AND tell the caller, or a caller that believes the batch landed never
	// retries it.
	for (const [when, nth, taken] of [
		['mid-batch', 50, 'issued'],
		['once its last write has landed', 100, 'landed']
	] as const) {
		test(`a transaction taken away ${when} fails the commit and leaves zero rows`, async () => {
			const name = `t04-${crypto.randomUUID()}`
			const store = idbStore(name)
			await store.commit([node({ id: 'held', name: 'taken.txt' })])

			const original = IDBObjectStore.prototype.put
			let puts = 0
			IDBObjectStore.prototype.put = function (this: IDBObjectStore, value, key) {
				const request = original.call(this, value, key)
				// Taken once the last write has LANDED is the harder half: every
				// request succeeded, and only the transaction knows the batch is
				// not durable.
				if (++puts === nth) {
					if (taken === 'issued') this.transaction.abort()
					else request.addEventListener('success', () => this.transaction.abort())
				}
				return request
			}
			const rows = batch()
			try {
				await expect(store.commit(rows, fresh100(rows))).rejects.toThrow()
			} finally {
				IDBObjectStore.prototype.put = original
			}

			const reopened = idbStore(name)
			expect((await reopened.since()).nodes.map((n) => n.id).sort()).toEqual([ROOT, 'held'].sort())
		})
	}

	test('a write that throws instead of failing a request rolls the whole batch back', async () => {
		const name = `t04-${crypto.randomUUID()}`
		const store = idbStore(name)
		await store.commit([node({ id: 'held', name: 'taken.txt' })])

		// A `put` can THROW rather than fail a request — an uncloneable value in a
		// row, a key the store cannot extract. IDB has no request to fail then, so
		// it does not abort the transaction on its own: the writes before this one
		// would commit while the caller is told the batch failed.
		const original = IDBObjectStore.prototype.put
		let puts = 0
		IDBObjectStore.prototype.put = function (this: IDBObjectStore, value, key) {
			if (++puts === 50) throw new DOMException('cannot clone', 'DataCloneError')
			return original.call(this, value, key)
		}
		const rows = batch()
		try {
			await expect(store.commit(rows, fresh100(rows))).rejects.toThrow()
		} finally {
			IDBObjectStore.prototype.put = original
		}

		const reopened = idbStore(name)
		expect((await reopened.since()).nodes.map((n) => n.id).sort()).toEqual([ROOT, 'held'].sort())
	})

	test('overlapping commits serialize: one free guard wins, the loser writes nothing', async () => {
		const store = fresh()
		const a = node({ id: 'a', name: 'race.txt' })
		const b = node({ id: 'b', name: 'race.txt' })
		const claim = { free: { parent: ROOT, name: 'race.txt' } } as const

		// Neither is awaited before the other starts, so both transactions are
		// open at once. IDB runs them one after the other; the second one's guard
		// must therefore see the first one's row.
		const settled = await Promise.allSettled([
			store.commit([a], [claim]),
			store.commit([b], [claim])
		])
		expect(settled.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])

		const winner = settled[0]?.status === 'fulfilled' ? a : b
		const loser = winner === a ? b : a
		expect(await store.child(ROOT, 'race.txt')).toEqual(winner)
		expect(await store.get(loser.id)).toBeNull()
	})

	test('overlapping commits both evaluate against committed state', async () => {
		const store = fresh()
		const one = node({ id: 'v', name: 'v.txt', version: 'v1' })
		await store.commit([one])

		// The second commit's guard names the version the FIRST one writes. It can
		// only pass if the first has already committed by the time it is read.
		const settled = await Promise.allSettled([
			store.commit([{ ...one, version: 'v2' }], [{ version: { id: 'v', is: 'v1' } }]),
			store.commit([{ ...one, version: 'v3' }], [{ version: { id: 'v', is: 'v2' } }])
		])
		expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
		expect((await store.get('v'))?.version).toBe('v3')
	})

	test('no wake is advertised, because a connection-local one would go stale', async () => {
		const name = `t04-${crypto.randomUUID()}`
		const one = idbStore(name)
		const two = idbStore(name)

		// The DATABASE is the store, not the connection — the reopen below proves
		// it, since a cursor one connection mints still means what it meant to the
		// next. A `subscribe` held in one connection's closure would never fire for
		// a second tab's commit, and T7 takes `subscribe` INSTEAD of polling
		// whenever a store offers one: the watcher would go permanently stale
		// rather than merely late. So this backend offers none.
		expect(one.subscribe).toBeUndefined()

		// And the fallback it leaves behind is the whole truth: `since` sees the
		// other connection's commits.
		await two.commit([node({ id: 'a', name: 'a.txt' })])
		expect((await one.since()).nodes.map((n) => n.id)).toContain('a')
	})

	test('open connections do not block database deletion', async () => {
		const name = `t04-${crypto.randomUUID()}`
		const one = idbStore(name)
		const two = idbStore(name)
		await Promise.all([one.get(ROOT), two.get(ROOT)])

		const deleted = new Promise<void>((resolve, reject) => {
			const request = indexedDB.deleteDatabase(name)
			request.onsuccess = () => resolve()
			request.onerror = () => reject(request.error)
			request.onblocked = () => reject(new Error('database deletion was blocked'))
		})

		await expect(deleted).resolves.toBeUndefined()
		await expect(one.get(ROOT)).rejects.toMatchObject({ name: 'InvalidStateError' })
	})

	test('the feed survives a reopen: rows, order and cursor outlive the connection', async () => {
		const name = `t04-${crypto.randomUUID()}`
		const store = idbStore(name)
		await store.commit([node({ id: 'a', name: 'a.txt' })])
		const caught = await store.since()
		if (!caught.next) throw new Error('since must always hand a cursor back')

		// A cursor is bound to the store's LINEAGE, not to its connection: a
		// reload is not a reset, so the position a replica saved still means what
		// it meant (rule 11).
		const reopened = idbStore(name)
		expect((await reopened.since(caught.next)).nodes).toEqual([])
		await reopened.commit([node({ id: 'b', name: 'b.txt' })])
		expect((await reopened.since(caught.next)).nodes.map((n) => n.id)).toEqual(['b'])
		// And the seq order continues from what is stored, rather than restarting
		// and burying `b` behind a cursor that already passed it.
		expect((await store.since(caught.next)).nodes.map((n) => n.id)).toEqual(['b'])
	})
})
