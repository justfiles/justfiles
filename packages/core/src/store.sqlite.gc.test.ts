import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { authority } from '../../fs/authority'
import { BootstrapRequiredError, bindCursor, receiver } from '../../fs/peer'
import { type Cursor, type Node, ROOT, type Store } from '../../fs/store'
import type { SyncDb } from './db'
import { createSqliteSyncDb } from './db.sqlite'
import { emptyStore, sqliteStore } from './store.sqlite'

const adapter = (database: DatabaseSync): SyncDb => {
	const db = {
		prepare(sql: string) {
			const statement = database.prepare(sql)
			statement.setReadBigInts(true)
			return statement
		},
		exec: (sql: string) => database.exec(sql)
	}
	return createSqliteSyncDb(db as unknown as Parameters<typeof createSqliteSyncDb>[0])
}

const node = (id: string, deleted = true): Node => ({
	id,
	parent: ROOT,
	name: `${id}.txt`,
	type: 'file',
	mode: 0o100644,
	mtimeNs: 0n,
	size: 0n,
	version: 'peer:1',
	...(deleted ? { deleted: true as const } : {})
})

const caughtUp = async (store: Store): Promise<Cursor> => {
	let cursor: Cursor | undefined
	for (;;) {
		const page = await store.since(cursor)
		if (!page.next) throw new Error('store did not return a cursor')
		cursor = page.next
		if (page.nodes.length === 0) return cursor
	}
}

const rows = async (store: Store): Promise<Node[]> => {
	const found: Node[] = []
	let cursor: Cursor | undefined
	for (;;) {
		const page = await store.since(cursor)
		found.push(...page.nodes)
		if (page.nodes.length === 0 || page.next === undefined) return found
		cursor = page.next
	}
}

describe('SQLite tombstone retention', () => {
	it('uses one strict retention boundary and deletes bounded batches', async () => {
		let now = 0
		const db = adapter(new DatabaseSync(':memory:'))
		const store = sqliteStore(db, undefined, {
			clock: () => now,
			policy: { tombstoneRetentionMs: 100, deleteBatch: 2 }
		})
		await store.commit(['a', 'b', 'c', 'd'].map((id) => node(id)))

		now = 100
		expect(await store.gc?.()).toEqual({ reclaimed: 0, done: true })
		now = 101
		await store.commit([node('recent'), node('live', false)])
		expect(await store.gc?.()).toEqual({ reclaimed: 2, done: false })
		expect(await store.gc?.()).toEqual({ reclaimed: 2, done: true })

		expect((await rows(store)).filter((row) => row.deleted).map((row) => row.id)).toEqual([
			'recent'
		])
		expect(await store.get('live')).toEqual(node('live', false))
		expect(db.query("SELECT value FROM meta WHERE key = 'feed_floor'")[0]?.value).toBe('5')
	})

	it('rolls deletion and feed-floor movement back together', async () => {
		let now = 0
		let failFloor = false
		const inner = adapter(new DatabaseSync(':memory:'))
		const db: SyncDb = {
			query: (sql, args) => inner.query(sql, args),
			exec(sql, args) {
				if (failFloor && args?.[1] === 'feed_floor') {
					failFloor = false
					throw new Error('floor write failed')
				}
				inner.exec(sql, args)
			},
			transactionSync: (body) => inner.transactionSync(body)
		}
		const store = sqliteStore(db, undefined, {
			clock: () => now,
			policy: { tombstoneRetentionMs: 100 }
		})
		await store.commit([node('old')])
		now = 101
		failFloor = true

		await expect(store.gc?.()).rejects.toThrow('floor write failed')
		expect(await store.get('old')).toEqual(node('old'))
		expect(db.query("SELECT value FROM meta WHERE key = 'feed_floor'")[0]?.value).toBe('0')

		expect(await store.gc?.()).toEqual({ reclaimed: 1, done: true })
		expect(await store.get('old')).toBeNull()
		expect(db.query("SELECT value FROM meta WHERE key = 'feed_floor'")[0]?.value).toBe('2')
	})

	it('invalidates a cursor before its missed tombstone can be resurrected', async () => {
		let now = 0
		const raw = sqliteStore(adapter(new DatabaseSync(':memory:')), undefined, {
			clock: () => now,
			policy: { tombstoneRetentionMs: 100 }
		})
		await raw.commit([node('gone')])
		const peer = receiver(authority(raw), {
			clock: () => now,
			policy: { tombstoneRetentionMs: 100 }
		})
		const cursor = await caughtUp(peer)

		now = 101
		expect(await raw.gc?.()).toEqual({ reclaimed: 1, done: true })
		const stale = bindCursor(peer, { load: async () => cursor })
		await expect(stale.commit([node('gone', false)])).rejects.toThrow(BootstrapRequiredError)
		expect(await raw.get('gone')).toBeNull()
	})

	it('a late maintenance run uses the same safety boundary', async () => {
		let now = 0
		const store = sqliteStore(adapter(new DatabaseSync(':memory:')), undefined, {
			clock: () => now,
			policy: { tombstoneRetentionMs: 100 }
		})
		await store.commit([node('old')])
		now = 10_000

		expect(await store.gc?.()).toEqual({ reclaimed: 1, done: true })
		expect(await store.get('old')).toBeNull()
	})

	it('never reuses a swept feed tail behind an issued cursor', async () => {
		let now = 0
		const store = sqliteStore(adapter(new DatabaseSync(':memory:')), undefined, {
			clock: () => now,
			policy: { tombstoneRetentionMs: 100 }
		})
		await store.commit([node('tail')])
		const issued = (await store.since()).next
		now = 101
		await store.gc?.()
		await store.commit([node('news', false)])

		expect((await store.since(issued)).nodes.map((row) => row.id)).toEqual(['news'])
	})

	it('persists issuer and signing state across reopen and rotates lineage on reset', async () => {
		const db = adapter(new DatabaseSync(':memory:'))
		const before = receiver(sqliteStore(db))
		const cursor = await caughtUp(before)

		await expect(receiver(sqliteStore(db)).since(cursor)).resolves.toMatchObject({ nodes: [] })
		db.transactionSync(() => emptyStore(db))
		await expect(receiver(sqliteStore(db)).since(cursor)).rejects.toThrow(BootstrapRequiredError)
	})
})
