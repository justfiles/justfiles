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
import type { SyncDb } from './db'
import { createSqliteSyncDb } from './db.sqlite'
import { sqliteStore } from './store.sqlite'

/**
 * node:sqlite returns INTEGER as a JS number by default and THROWS on values
 * beyond 2^53 (`mtimeNs` is one). Read integers as bigint — the store's own
 * conversions already accept both, as bun:sqlite and the DO adapter hand back
 * either.
 */
const adapter = (db: DatabaseSync): SyncDb => {
	const db64 = {
		prepare(sql: string) {
			const statement = db.prepare(sql)
			statement.setReadBigInts(true)
			return statement
		},
		exec: (sql: string) => db.exec(sql)
	}
	return createSqliteSyncDb(db64 as unknown as Parameters<typeof createSqliteSyncDb>[0])
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
const likeDurableObject = (db: DatabaseSync): SyncDb => {
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
	return createSqliteSyncDb(asDO as unknown as Parameters<typeof createSqliteSyncDb>[0])
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
 * A `SyncDb` that records every statement and the transaction it ran in —
 * `null` for a statement that ran in none.
 */
const recording = (inner: SyncDb): { db: SyncDb; log: { tx: number | null; sql: string }[] } => {
	const log: { tx: number | null; sql: string }[] = []
	let open: number | null = null
	let opened = 0
	return {
		log,
		db: {
			query: <T extends Record<string, unknown>>(
				sql: string,
				args?: Parameters<SyncDb['exec']>[1]
			) => {
				log.push({ tx: open, sql })
				return inner.query<T>(sql, args)
			},
			exec: (sql, args) => {
				log.push({ tx: open, sql })
				inner.exec(sql, args)
			},
			transactionSync: (fn) => {
				open = opened++
				try {
					inner.transactionSync(fn)
				} finally {
					open = null
				}
			}
		}
	}
}

storeConformance('sqliteStore', async () => fresh())

/**
 * A connection where the write naming `stops` fails, so a batch stops in the
 * middle. Its `transactionSync` is the real one: the platform HAS a rollback,
 * and the question is whether the store uses it.
 */
const failing = (db: DatabaseSync, stops: string): SyncDb => {
	const inner = adapter(db)
	return {
		...inner,
		exec: (sql, args) => {
			if (args?.includes(stops)) throw new Error('out of space')
			inner.exec(sql, args)
		}
	}
}

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

describe('sqliteStore: rule 2 on the platform whose transaction has no rollback', () => {
	test('a write that fails mid-batch leaves the rows before it out too', async () => {
		const db = new DatabaseSync(':memory:')
		const store = sqliteStore(failing(db, 'n1'))
		await store.commit([node({ id: 'seed', name: 'seed.txt' })])

		// A quota, a row limit, a broken connection: the batch stops in the middle,
		// and rule 2 says the store then holds none of it. `DbAdapter.transaction` is
		// a bare `await fn(adapter)` on the Durable Object with nothing to roll back,
		// which is why this store speaks the synchronous seam instead.
		const rows = [node({ id: 'n0', name: 'f0.txt' }), node({ id: 'n1', name: 'f1.txt' })]
		await expect(store.commit(rows)).rejects.toThrow('out of space')

		expect(await store.get('n0')).toBeNull()
		expect(await store.get('n1')).toBeNull()
		// … and the feed took no position for either, so no replica ever hears of one.
		expect((await store.since()).nodes.map((row) => row.id)).toEqual([ROOT, 'seed'])
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

describe('sqliteStore: two stores in one database', () => {
	test('a namespaced store shares no row, no blob and no lineage with the default one', async () => {
		// The server's tree and its `/private` (T15's mount) are two stores over one
		// Durable Object, so "separate store" has to mean separate TABLES here.
		const db = new DatabaseSync(':memory:')
		const synced = sqliteStore(adapter(db))
		const local = sqliteStore(adapter(db), { namespace: 'private' })

		await synced.commit([node({ id: 'a', name: 'shared.txt' })])
		await local.commit([node({ id: 'b', name: 'secret.txt' })])
		await local.blobs.put('cafe', new Uint8Array([1]))

		expect(await local.get('a')).toBeNull()
		expect(await synced.get('b')).toBeNull()
		expect(await synced.child(ROOT, 'secret.txt')).toBeNull()
		expect(await synced.blobs.has('cafe')).toBe(false)
		// Each feed carries its own rows and only its own root (rule 6 on both).
		expect((await synced.since()).nodes.map((row) => row.id)).toEqual([ROOT, 'a'])
		expect((await local.since()).nodes.map((row) => row.id)).toEqual([ROOT, 'b'])
		// And a cursor is a position in ONE feed: two lineages, so neither answers
		// to the other's (rule 11).
		const { next: cursor } = await local.since()
		await expect(synced.since(cursor)).rejects.toThrow()
	})

	test('a namespace that is not a bare identifier is refused, not interpolated', () => {
		// The name is a table name, so it goes into the SQL as itself. Quoting every
		// identifier would let `user-data` through; refusing it says the mistake where
		// it was made instead of `near "-": syntax error` on the first read — and it
		// leaves nothing to interpolate that could be anything but a name.
		for (const namespace of ['user-data', 'a b', 'private"', '1st', ''])
			expect(() => sqliteStore(adapter(new DatabaseSync(':memory:')), { namespace })).toThrow(
				/namespace/
			)
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
