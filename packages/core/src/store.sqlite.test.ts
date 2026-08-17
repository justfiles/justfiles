/**
 * The durable `Store`, held to the same contract as every other backend.
 *
 * The setup is `storage.sqlite.conformance.test.ts`'s: the backend takes an
 * abstract `DbAdapter`, and here it is backed by node's built-in `node:sqlite`
 * so it runs under the normal vitest/node `pnpm test` — no bun, no Durable
 * Object. What this file adds beyond the shared suite is what only a DURABLE
 * store can be wrong about: that a guard and its writes share one SQL
 * transaction, and that the order and the lineage outlive the connection.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, test } from 'vitest'
import { type Guard, GuardError, type Node, ROOT } from '../../fs/store'
import { storeConformance } from '../../fs/store.conformance'
import type { DbAdapter } from './db'
import { createSqliteAdapter } from './db.sqlite'
import { sqliteStore } from './store.sqlite'

/**
 * node:sqlite returns INTEGER as a JS number by default and THROWS on values
 * beyond 2^53 (`mtimeNs` is one). Read integers as bigint — the store's own
 * conversions already accept both, as bun:sqlite and the DO adapter hand back
 * either.
 */
const adapter = (db: DatabaseSync): DbAdapter => {
	const db64 = {
		prepare(sql: string) {
			const statement = db.prepare(sql)
			statement.setReadBigInts(true)
			return statement
		},
		exec: (sql: string) => db.exec(sql)
	}
	return createSqliteAdapter(db64 as unknown as Parameters<typeof createSqliteAdapter>[0])
}

/** A fresh in-memory database per store, so two `open()` calls are two lineages. */
const fresh = () => sqliteStore(adapter(new DatabaseSync(':memory:')))

/**
 * The PRODUCTION adapter's value handling, which the one above does not share:
 * `createDOSqliteAdapter` binds a bigint as a decimal string, and the Durable
 * Object hands every column back as `ArrayBuffer | string | number | null` —
 * `SqlStorageValue` has no bigint. Reading integers as numbers (no
 * `setReadBigInts`) is what reproduces that half here.
 */
const likeDurableObject = (db: DatabaseSync): DbAdapter => {
	const digits = (args: unknown[]) =>
		args.map((arg) => (typeof arg === 'bigint' ? arg.toString() : arg))
	const asDO = {
		prepare(sql: string) {
			const statement = db.prepare(sql)
			return {
				all: (...args: unknown[]) => statement.all(...(digits(args) as [])),
				run: (...args: unknown[]) => statement.run(...(digits(args) as []))
			}
		},
		exec: (sql: string) => db.exec(sql)
	}
	return createSqliteAdapter(asDO as unknown as Parameters<typeof createSqliteAdapter>[0])
}

const dir = mkdtempSync(join(tmpdir(), 't12-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A database on disk, so "reopen" means what it means to a server: a new process. */
const onDisk = (name: string) => {
	const file = join(dir, `${name}.sqlite`)
	return () => sqliteStore(adapter(new DatabaseSync(file)))
}

const node = (over: Partial<Node> & Pick<Node, 'id' | 'name'>): Node => ({
	parent: ROOT,
	type: 'file',
	mode: 0o100644,
	mtimeNs: 0n,
	size: 0n,
	version: '1',
	...over
})

/** 100 siblings, and a guard per row that passes. */
const batch = (): Node[] =>
	Array.from({ length: 100 }, (_, i) => node({ id: `n${i}`, name: `f${i}.txt` }))
const allNew = (rows: Node[]): Guard[] => rows.map((row) => ({ version: { id: row.id, is: null } }))

/**
 * A `DbAdapter` that records every statement and the transaction it ran in —
 * `null` for a statement that ran in none. A nested `transaction` is the same
 * transaction, because SQLite has no nesting (`db.sqlite.ts`).
 */
const recording = (
	inner: DbAdapter
): { db: DbAdapter; log: { tx: number | null; sql: string }[] } => {
	const log: { tx: number | null; sql: string }[] = []
	let opened = 0
	const wrap = (db: DbAdapter, tx: number | null): DbAdapter => ({
		query: (sql, args) => {
			log.push({ tx, sql })
			return db.query(sql, args)
		},
		run: (sql, args) => {
			log.push({ tx, sql })
			return db.run(sql, args)
		},
		transaction: (fn) => {
			const id = tx ?? opened++
			return db.transaction((inside) => fn(wrap(inside, id)))
		}
	})
	return { db: wrap(inner, null), log }
}

storeConformance('sqliteStore', async () => fresh())

describe('sqliteStore: the guard and its writes are one transaction', () => {
	test('a failed guard in a 100-row batch commits zero rows, and every statement shared one transaction', async () => {
		const db = new DatabaseSync(':memory:')
		const { db: recorder, log } = recording(adapter(db))
		const store = sqliteStore(recorder)
		// Opens the schema and seeds root, so only the commit under test is counted.
		await store.commit([node({ id: 'held', name: 'taken.txt' })])
		log.length = 0

		const rows = batch()
		await expect(
			store.commit(rows, [
				...allNew(rows),
				{ free: { parent: ROOT, name: 'taken.txt' } } // fails, and it is last
			])
		).rejects.toThrow(GuardError)

		// One transaction for 101 guards and 100 writes. A guard evaluated in a
		// transaction the writes do not share is a race, not a guard: what it
		// passed against can change before the writes land.
		expect(log.length).toBeGreaterThan(0)
		expect(new Set(log.map((entry) => entry.tx)).size).toBe(1)
		expect(log.some((entry) => entry.tx === null)).toBe(false)

		// Counted in SQL, not through the store: what survives is what the
		// transaction committed.
		const count = () =>
			Number(
				(db.prepare('SELECT COUNT(*) AS rows FROM nodes').get() as Record<string, unknown>).rows
			)
		expect(count()).toBe(2) // root and `held`

		// The positive control, so "zero rows" means the guard and not a batch this
		// backend simply cannot write: the same 100 rows, guards that pass.
		await store.commit(rows, allNew(rows))
		expect(count()).toBe(102)
		expect((await store.get('n99'))?.name).toBe('f99.txt')
	})
})

describe('sqliteStore: the production adapter reads every column as a number', () => {
	test('a nanosecond mtime and a 64-bit size survive the round trip intact', async () => {
		const store = sqliteStore(likeDurableObject(new DatabaseSync(':memory:')))
		// Both are past 2^53, where a JS number stops counting in ones: an epoch
		// nanosecond stamp is the ordinary case, not a corner one.
		const row = node({
			id: 'a',
			name: 'a.txt',
			mtimeNs: 1_755_000_000_123_456_789n,
			size: 9_007_199_254_740_993n
		})
		await store.commit([row])

		// A row that reads back rounded is a row the store cannot recognise as the
		// one it holds …
		expect(await store.get('a')).toEqual(row)
		expect(await store.child(ROOT, 'a.txt')).toEqual(row)

		// … so rule 3's no-op is what actually breaks: every re-commit would land
		// again and take a new feed position, for as long as the row exists.
		const mark = (await store.since()).next
		await store.commit([row])
		expect((await store.since(mark)).nodes).toEqual([])
	})
})

describe('sqliteStore: what outlives the connection', () => {
	test('seq is monotonic across reopens: a saved cursor still leads to the news', async () => {
		const open = onDisk('order')
		const store = open()
		await store.commit([node({ id: 'a', name: 'a.txt' })])
		const caught = await store.since()
		if (!caught.next) throw new Error('since must always hand a cursor back')

		// The order lives in the table, not in the process that wrote it. A reopen
		// that restarted `seq` at zero would bury `b` behind a cursor that has
		// already passed it — the row would be lost to every replica that saved one.
		const reopened = open()
		await reopened.commit([node({ id: 'b', name: 'b.txt' })])
		expect((await reopened.since(caught.next)).nodes.map((n) => n.id)).toEqual(['b'])
		expect((await open().since(caught.next)).nodes.map((n) => n.id)).toEqual(['b'])
	})

	test('the lineage persists: a reopened store accepts its own old cursors (rule 11)', async () => {
		const open = onDisk('lineage')
		const store = open()
		await store.commit([node({ id: 'a', name: 'a.txt' })])
		const { next: cursor } = await store.since()
		if (!cursor) throw new Error('since must always hand a cursor back')

		// Unlike memStore, which mints a lineage per instance, a durable store's
		// lineage is stored beside its rows: a restart is not a reset, so the
		// position a replica saved yesterday still means what it meant.
		const reopened = open()
		expect((await reopened.since(cursor)).nodes).toEqual([])
		await reopened.commit([node({ id: 'b', name: 'b.txt' })])
		expect((await reopened.since(cursor)).nodes.map((n) => n.id)).toEqual(['b'])

		// And the fence still stands where it should: another database is another
		// lineage, and it rejects this cursor rather than answering it (rule 11).
		await expect(onDisk('other')().since(cursor)).rejects.toThrow()
	})
})
