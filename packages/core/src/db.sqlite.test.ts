/**
 * `createSqliteAdapter` drives ONE synchronous connection, and every mutation's
 * transaction body is `async` — so two callers that overlap interleave on that single
 * connection. Before #339 nothing stopped them, and one connection cannot hold two
 * transactions:
 *
 *   - the second `BEGIN` fails with "cannot start a transaction within a transaction",
 *     an error no caller has a word for (`claimPath` retries EEXIST and rethrows the rest);
 *   - worse, the two are then the SAME transaction, so the loser's `ROLLBACK` discards the
 *     winner's committed work, and a bystanding write issued in that window goes with it;
 *   - and an outside read sees the half-applied middle of someone else's transaction.
 *
 * These are three faces of one fact, so they get one fix: entry is serialised, and the body
 * receives an adapter that is already inside the transaction (so its own statements never
 * queue behind it). Nothing about `DbAdapter` changes — this is the driver keeping a promise
 * the word "transaction" already made.
 */

import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createSqliteAdapter } from './db.sqlite'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function makeAdapter() {
	const db = new DatabaseSync(':memory:')
	db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, tag TEXT)')
	const shim = {
		prepare: (sql: string) => db.prepare(sql),
		exec: (sql: string) => db.exec(sql)
	}
	const adapter = createSqliteAdapter(shim as unknown as Parameters<typeof createSqliteAdapter>[0])
	const ids = () =>
		(db.prepare('SELECT id FROM t ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id)
	return { adapter, ids }
}

test('two overlapping transactions both commit', async () => {
	// Each awaits mid-body, which is what every sqliteStorage mutation does (pathOf,
	// enumerateSubtree, getDirent). Unqueued, the second BEGIN throws.
	const { adapter, ids } = makeAdapter()
	const write = (id: number) =>
		adapter.transaction(async (tx) => {
			await tx.run('INSERT INTO t (id, tag) VALUES (?, ?)', [id, `tx-${id}`])
			await tick()
			await tx.run('UPDATE t SET tag = ? WHERE id = ?', [`done-${id}`, id])
		})
	const results = await Promise.allSettled([write(1), write(2)])
	expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
	expect(ids()).toEqual([1, 2])
})

test("a failed transaction's rollback cannot discard another writer's work", async () => {
	// The dangerous half. Sharing one real transaction means ROLLBACK is not scoped to the
	// caller that asked for it: a committed neighbour and an unrelated write both vanish.
	const { adapter, ids } = makeAdapter()
	const committed = adapter.transaction(async (tx) => {
		await tx.run('INSERT INTO t (id, tag) VALUES (1, ?)', ['keeper'])
	})
	const doomed = adapter.transaction(async (tx) => {
		await tx.run('INSERT INTO t (id, tag) VALUES (2, ?)', ['doomed'])
		await tick()
		throw new Error('boom')
	})
	const bystander = (async () => {
		await tick()
		await adapter.run('INSERT INTO t (id, tag) VALUES (3, ?)', ['bystander'])
	})()

	await committed
	await expect(doomed).rejects.toThrow('boom')
	await bystander

	// Only the transaction that threw loses its row.
	expect(ids()).toEqual([1, 3])
})

test('a read outside a transaction never sees its half-applied middle', async () => {
	// One connection means an outside statement runs INSIDE whatever transaction is open,
	// so an unserialised reader can observe a state no commit ever produced — a rename with
	// its old dirent deleted and its new one not yet written, for instance.
	const { adapter } = makeAdapter()
	await adapter.run('INSERT INTO t (id, tag) VALUES (1, ?)', ['before'])
	const seen: number[] = []
	const move = adapter.transaction(async (tx) => {
		await tx.run('DELETE FROM t WHERE id = 1')
		await tick() // the window a reader could land in
		await tx.run('INSERT INTO t (id, tag) VALUES (2, ?)', ['after'])
	})
	const reader = (async () => {
		await tick()
		const rows = await adapter.query<{ id: number }>('SELECT id FROM t ORDER BY id')
		seen.push(...rows.map((r) => r.id))
	})()
	await move
	await reader
	// The row is either where it started or where it ended — never nowhere.
	expect(seen).toEqual([2])
})

test('a transaction body is not queued behind itself', async () => {
	// The deadlock the fix must not introduce: the body's own statements are already inside
	// the transaction, so they run straight through and can read their own uncommitted work.
	const { adapter } = makeAdapter()
	await adapter.transaction(async (tx) => {
		await tx.run('INSERT INTO t (id, tag) VALUES (1, ?)', ['mine'])
		const rows = await tx.query<{ tag: string }>('SELECT tag FROM t WHERE id = 1')
		expect(rows.map((r) => r.tag)).toEqual(['mine'])
		// And a nested `transaction` is the same one — SQLite has no nesting, so it runs
		// inline rather than waiting for a lock its own caller is holding.
		await tx.transaction(async (inner) => {
			await inner.run('INSERT INTO t (id, tag) VALUES (2, ?)', ['nested'])
		})
	})
	const rows = await adapter.query<{ id: number }>('SELECT id FROM t ORDER BY id')
	expect(rows.map((r) => r.id)).toEqual([1, 2])
})
