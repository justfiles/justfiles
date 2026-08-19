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
import {
	ForeignCursorError,
	type Guard,
	GuardError,
	type Node,
	ROOT,
	sha256Hex
} from '../../fs/store'
import { storeConformance } from '../../fs/store.conformance'
import type { SyncDb } from './db'
import { createSqliteSyncDb } from './db.sqlite'
import { emptyStore, sqliteStore } from './store.sqlite'

/** The one definition of a `Hash`, so a test never invents one the store would refuse. */
const sha = (text: string) => sha256Hex(new TextEncoder().encode(text))

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
	test('a second store shares no row, no blob and no lineage with the first', async () => {
		// The server's tree and its `/private` (T15's mount) are two stores over one
		// Durable Object, so "separate store" has to mean separate TABLES here.
		const db = new DatabaseSync(':memory:')
		const synced = sqliteStore(adapter(db))
		const local = sqliteStore(adapter(db), crypto.randomUUID())

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

	test('a store id is data, so nothing about it can reach the schema', async () => {
		// The id is a bound parameter, so there is no name to quote, validate or
		// migrate: `user-data` is as good an id as any, and renaming the mount point
		// it is joined at touches only the parent store's row.
		const db = new DatabaseSync(':memory:')
		const odd = sqliteStore(adapter(db), 'user-data / a "quoted" name; DROP TABLE nodes--')
		await odd.commit([node({ id: 'a', name: 'a.txt' })])
		expect((await odd.get('a'))?.name).toBe('a.txt')
		// Every store is a row in one table, findable without reading `sqlite_master`.
		expect(
			db
				.prepare('SELECT id FROM stores ORDER BY sid')
				.all()
				.map((row) => (row as { id: string }).id)
		).toEqual(['user-data / a "quoted" name; DROP TABLE nodes--'])
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

describe('sqliteStore: the sweep', () => {
	/** A store and the database under it, because a reset is the database's, not the handle's. */
	const pair = () => {
		const db = adapter(new DatabaseSync(':memory:'))
		return { db, store: sqliteStore(db) }
	}

	const bytes = (text: string) => new TextEncoder().encode(text)

	/** Age every blob past the grace window, which is the only thing a clock buys here. */
	const age = (db: SyncDb) => db.exec('UPDATE blobs SET touched_ms = 0')

	test('collects bytes no live row names, and keeps the ones that are named', async () => {
		const { db, store } = pair()
		const kept = await sha('kept')
		const orphan = await sha('orphan')
		await store.blobs.put(kept, bytes('kept'))
		await store.blobs.put(orphan, bytes('orphan'))
		await store.commit([node({ id: 'a', name: 'a.txt', content: kept })])
		age(db)

		expect(await store.gc?.()).toEqual({ reclaimed: 1, done: true })
		expect(await store.blobs.has(kept)).toBe(true)
		expect(await store.blobs.has(orphan)).toBe(false)
	})

	test('bytes still inside the grace window survive: a push puts them before it commits', async () => {
		const { store } = pair()
		const hash = await sha('in flight')
		await store.blobs.put(hash, bytes('in flight'))

		// Rule 10's two steps are two REQUESTS on a server, and the engine never
		// offers a pushed row's bytes twice — so collecting them in between would
		// leave a permanent stub with nobody left to fill it.
		expect(await store.gc?.()).toEqual({ reclaimed: 0, done: true })
		expect(await store.blobs.has(hash)).toBe(true)
	})

	test('a tombstone keeps nothing alive: its content is unreadable by anyone', async () => {
		const { db, store } = pair()
		const hash = await sha('deleted')
		await store.blobs.put(hash, bytes('deleted'))
		await store.commit([node({ id: 'a', name: 'a.txt', content: hash })])
		await store.commit([
			node({ id: 'a', name: 'a.txt', content: hash, deleted: true, version: '2' })
		])
		age(db)

		expect(await store.gc?.()).toEqual({ reclaimed: 1, done: true })
		expect(await store.blobs.has(hash)).toBe(false)
	})

	test('one store never keeps another store’s bytes alive', async () => {
		const db = adapter(new DatabaseSync(':memory:'))
		const synced = sqliteStore(db)
		const local = sqliteStore(db, 'private')
		const shared = await sha('shared')
		await synced.blobs.put(shared, bytes('shared'))
		await local.blobs.put(shared, bytes('shared'))
		// Named in the LOCAL store only. The two blob rows are two rows, so the
		// synced store's copy is unreferenced and the local one is not.
		await local.commit([node({ id: 'a', name: 'a.txt', content: shared })])
		age(db)

		expect(await synced.gc?.()).toEqual({ reclaimed: 1, done: true })
		expect(await synced.blobs.has(shared)).toBe(false)
		expect(await local.blobs.has(shared)).toBe(true)
	})

	test('asking renews the lease, so a re-adopted blob survives the sweep', async () => {
		const { db, store } = pair()
		const hash = await sha('re-adopted')
		await store.blobs.put(hash, bytes('re-adopted'))
		// Unreferenced since last week: nothing about when these bytes were WRITTEN
		// protects them any more.
		age(db)

		// A pusher asks before deciding not to upload. Told yes, it skips the upload and
		// commits two round trips later — and this is the window the sweep must not use.
		expect(await store.blobs.has(hash)).toBe(true)
		expect(await store.gc?.()).toEqual({ reclaimed: 0, done: true })
		expect(await store.blobs.has(hash)).toBe(true)

		// The row that ends the race, and the blob stops being a candidate at all.
		await store.commit([node({ id: 'a', name: 'a.txt', content: hash })])
		expect(await store.gc?.()).toEqual({ reclaimed: 0, done: true })
		expect(await store.blobs.get(hash)).toEqual(bytes('re-adopted'))
	})

	test('asking about a blob it does not hold renews nothing', async () => {
		const { store } = pair()

		expect(await store.blobs.has(await sha('never here'))).toBe(false)
	})

	test('a full slice reports more to do, and a second pass finishes it', async () => {
		const { db, store } = pair()
		for (let i = 0; i < 130; i++) await store.blobs.put(await sha(`b${i}`), bytes(`b${i}`))
		age(db)

		expect(await store.gc?.()).toEqual({ reclaimed: 128, done: false })
		expect(await store.gc?.()).toEqual({ reclaimed: 2, done: true })
	})
})

describe('emptyStore: the authority starts a new lineage', () => {
	const bytes = (text: string) => new TextEncoder().encode(text)

	test('every row but the root goes, and the cursors that watched them are fenced', async () => {
		const db = adapter(new DatabaseSync(':memory:'))
		const store = sqliteStore(db)
		await store.commit([node({ id: 'a', name: 'a.txt' })])
		const { next: cursor } = await store.since()
		if (!cursor) throw new Error('since must always hand a cursor back')

		db.transactionSync(() => emptyStore(db))

		// The handle that was open when it happened is stale, exactly as documented:
		// it still holds the lineage it read at open. A fresh one is what a restarted
		// instance has, and it is what answers here.
		const after = sqliteStore(db)
		// Rule 6's root row is all that is left, and it is all a scan finds.
		expect((await after.since()).nodes.map((n) => n.id)).toEqual([ROOT])
		expect(await after.get(ROOT)).not.toBeNull()
		await expect(after.since(cursor)).rejects.toThrow(ForeignCursorError)
	})

	test('content survives an adopt-mine and goes with a wipe', async () => {
		const db = adapter(new DatabaseSync(':memory:'))
		const hash = await sha('kept')
		await sqliteStore(db).blobs.put(hash, bytes('kept'))

		db.transactionSync(() => emptyStore(db))
		// The initiator republishes rows it may only hold as stubs, so the bytes
		// behind them have to still be here.
		expect(await sqliteStore(db).blobs.has(hash)).toBe(true)

		db.transactionSync(() => emptyStore(db, undefined, { content: 'drop' }))
		expect(await sqliteStore(db).blobs.has(hash)).toBe(false)
	})

	test('it empties the store it is named, and no other', async () => {
		const db = adapter(new DatabaseSync(':memory:'))
		const synced = sqliteStore(db)
		const local = sqliteStore(db, 'private')
		await synced.commit([node({ id: 'a', name: 'a.txt' })])
		await local.commit([node({ id: 'b', name: 'b.txt' })])

		db.transactionSync(() => emptyStore(db))

		expect((await sqliteStore(db).since()).nodes.map((n) => n.id)).toEqual([ROOT])
		// The whole point of the DO holding two: an adopt-mine truncates the tree the
		// client republishes and cannot touch the credentials it has never seen.
		expect((await sqliteStore(db, 'private').since()).nodes.map((n) => n.id)).toEqual([ROOT, 'b'])
	})
})

describe('sqliteStore: bytes too big for a row', () => {
	/**
	 * An object store, and a database that refuses a row over 2 MB the way Workers
	 * SQLite does — the whole reason the offload exists, so the test has to have it.
	 */
	const durable = () => {
		const objects = new Map<string, Uint8Array>()
		// A delete a test can hold open, the way a round trip to R2 is open for a while.
		let inflight: Promise<void> | undefined
		let finish: (() => void) | undefined
		const raw = adapter(new DatabaseSync(':memory:'))
		const db: SyncDb = {
			...raw,
			exec: (sql, args) => {
				for (const arg of args ?? [])
					if (arg instanceof Uint8Array && arg.byteLength > 2 * 1024 * 1024)
						throw new Error('Row too large')
				raw.exec(sql, args)
			}
		}
		const blobs = {
			puts: 0,
			async put(key: string, value: ArrayBuffer | ArrayBufferView) {
				blobs.puts++
				objects.set(key, new Uint8Array(value as ArrayBuffer))
			},
			async get(key: string) {
				const held = objects.get(key)
				return held === undefined
					? null
					: {
							async arrayBuffer() {
								return held.buffer as ArrayBuffer
							}
						}
			},
			async delete(keys: string | string[]) {
				await inflight
				for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key)
			},
			hold() {
				inflight = new Promise<void>((resolve) => (finish = resolve))
			},
			land() {
				finish?.()
			}
		}
		return { db, blobs, objects }
	}

	const big = (size: number) => new Uint8Array(size).fill(7)

	test('a file over the row limit round-trips through the external store', async () => {
		const { db, blobs, objects } = durable()
		const store = sqliteStore(db, undefined, { blobs })
		const data = big(3 * 1024 * 1024)
		const hash = await sha256Hex(data)

		await store.blobs.put(hash, data)

		// The row names where the bytes are; the bytes are not in it. Without this the
		// put throws outright, which is what a 2 MB cap does to a store that inlines.
		expect([...objects.keys()]).toEqual([`main/${hash}`])
		expect(await store.blobs.has(hash)).toBe(true)
		expect(await store.blobs.get(hash)).toEqual(data)
	})

	test('without one, the same file cannot be stored at all', async () => {
		const { db } = durable()
		const store = sqliteStore(db)
		const data = big(3 * 1024 * 1024)

		// The reason the offload exists, pinned: a Workers SQLite row is capped at 2 MB,
		// so a store that inlines everything refuses the write outright — and on the
		// Durable Object that refusal lands inside the boot barrier, where it takes every
		// request to that object down with it.
		await expect(store.blobs.put(await sha256Hex(data), data)).rejects.toThrow('Row too large')
	})

	test('small bytes stay in the row: an offload is a size answer, not a policy', async () => {
		const { db, blobs, objects } = durable()
		const store = sqliteStore(db, undefined, { blobs })
		const data = big(1024)
		const hash = await sha256Hex(data)

		await store.blobs.put(hash, data)

		expect(objects.size).toBe(0)
		expect(await store.blobs.get(hash)).toEqual(data)
	})

	test('a second put of the same hash uploads nothing', async () => {
		const { db, blobs } = durable()
		const store = sqliteStore(db, undefined, { blobs })
		const data = big(3 * 1024 * 1024)
		const hash = await sha256Hex(data)

		await store.blobs.put(hash, data)
		await store.blobs.put(hash, data)

		// Rule 7: a hash the store already holds is already the answer. This is what
		// keeps a re-run of the one pass from re-uploading a volume it already moved.
		expect(blobs.puts).toBe(1)
	})

	test('the sweep collects the object too, after the row that named it', async () => {
		const { db, blobs, objects } = durable()
		const store = sqliteStore(db, undefined, { blobs })
		const data = big(3 * 1024 * 1024)
		const hash = await sha256Hex(data)
		await store.blobs.put(hash, data)
		db.exec('UPDATE blobs SET touched_ms = 0')

		expect(await store.gc?.()).toEqual({ reclaimed: 1, done: true })
		expect(objects.size).toBe(0)
	})

	test('two stores over one database never share an object', async () => {
		const { db, blobs, objects } = durable()
		const data = big(3 * 1024 * 1024)
		const hash = await sha256Hex(data)

		await sqliteStore(db, undefined, { blobs }).blobs.put(hash, data)
		await sqliteStore(db, 'private', { blobs }).blobs.put(hash, data)

		// The same bytes, and still two objects: a hash in the local store must not be
		// fetchable through the synced one's blob route, and the key is what draws that
		// boundary outside the database as `sid` draws it inside.
		expect([...objects.keys()].sort()).toEqual([`main/${hash}`, `private/${hash}`])
	})

	test('a row whose object is gone reads as absent, not as a failure', async () => {
		const { db, blobs, objects } = durable()
		const store = sqliteStore(db, undefined, { blobs })
		const data = big(3 * 1024 * 1024)
		const hash = await sha256Hex(data)
		await store.blobs.put(hash, data)
		objects.clear()

		// The seam's own answer to content that is not here: a reader is told rather
		// than guessed at, and `hydratingBlobs` asks the peer.
		expect(await store.blobs.get(hash)).toBeNull()
	})

	test('a push mid-sweep waits for the delete that is already on its way', async () => {
		const { db, blobs } = durable()
		const store = sqliteStore(db, undefined, { blobs })
		const data = big(3 * 1024 * 1024)
		const hash = await sha256Hex(data)
		await store.blobs.put(hash, data)
		db.exec('UPDATE blobs SET touched_ms = 0')

		// The window the sweep cannot close by ordering alone: the row is already gone,
		// so a push asks, is told no, and adopts the same hash into the same key while the
		// object delete is still in flight. The Durable Object holds no input gate across
		// that request, so this interleaving is the deployed one.
		blobs.hold()
		const sweep = store.gc?.()
		const adopt = store.blobs.put(hash, data)
		blobs.land()
		await Promise.all([sweep, adopt])

		// The re-adopted bytes survive their own collection. Without the wait the delete
		// lands after the upload, and the row the push is about to commit names nothing —
		// with no peer left that knows to offer the content again.
		expect(await store.blobs.get(hash)).toEqual(data)
	})
})
