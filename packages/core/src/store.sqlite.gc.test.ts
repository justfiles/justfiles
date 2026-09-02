import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { authority } from '../../fs/authority'
import {
	BootstrapRequiredError,
	type ReceiverStore,
	receiver,
	syncPolicy,
	syncStateLock
} from '../../fs/peer'
import { GuardError, type Node, ROOT } from '../../fs/store'
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

const rows = async (store: ReturnType<typeof sqliteStore>): Promise<Node[]> => {
	const found: Node[] = []
	let cursor: string | undefined
	for (;;) {
		const page = await store.since(cursor)
		found.push(...page.nodes)
		if (page.nodes.length === 0 || page.next === undefined) return found
		cursor = page.next
	}
}

const deferred = () => {
	let resolve!: () => void
	return { promise: new Promise<void>((done) => (resolve = done)), resolve }
}

describe('SQLite tombstone retention', () => {
	it('fences the full old range without deleting a bounded batch', async () => {
		let now = 0
		const db = adapter(new DatabaseSync(':memory:'))
		const policy = syncPolicy({
			cursorLeaseMs: 100,
			writeLeaseMs: 20,
			maxWriteDurationMs: 10,
			tombstoneFenceAgeMs: 100,
			tombstoneGraceMs: 31,
			deleteBatch: 2
		})
		const store = sqliteStore(db, undefined, {
			clock: () => now,
			lock: syncStateLock(),
			policy
		})
		await store.commit(['a', 'b', 'c', 'd'].map((id) => node(id)))
		now = 101
		await store.commit([node('recent'), node('live', false)])

		expect(await store.gc?.()).toEqual({ reclaimed: 0, done: true })
		expect((await rows(store)).filter((row) => row.deleted).map((row) => row.id)).toEqual([
			'a',
			'b',
			'c',
			'd',
			'recent'
		])
		expect(await store.get('live')).toEqual(node('live', false))

		const [floor] = db.query<{ value: string }>("SELECT value FROM meta WHERE key = 'feed_floor'")
		const [pending] = db.query<{ value: string }>(
			"SELECT value FROM meta WHERE key = 'pending_fence'"
		)
		expect(Number(floor?.value)).toBe(5)
		expect(JSON.parse(pending?.value ?? '')).toEqual({ through: 4, fencedAt: 101 })
	})

	it('advances the feed floor and fence checkpoint atomically', async () => {
		let now = 0
		let failFence = false
		const inner = adapter(new DatabaseSync(':memory:'))
		const db: SyncDb = {
			query: (sql, args) => inner.query(sql, args),
			exec(sql, args) {
				if (failFence && args?.[1] === 'pending_fence') {
					failFence = false
					throw new Error('checkpoint write failed')
				}
				inner.exec(sql, args)
			},
			transactionSync: (body) => inner.transactionSync(body)
		}
		const store = sqliteStore(db, undefined, {
			clock: () => now,
			policy: {
				cursorLeaseMs: 100,
				writeLeaseMs: 20,
				maxWriteDurationMs: 10,
				tombstoneFenceAgeMs: 100,
				tombstoneGraceMs: 31
			}
		})
		await store.commit([node('old')])
		now = 101
		failFence = true

		await expect(store.gc?.()).rejects.toThrow('checkpoint write failed')
		expect(db.query("SELECT value FROM meta WHERE key = 'feed_floor'")[0]?.value).toBe('0')
		expect(db.query("SELECT value FROM meta WHERE key = 'pending_fence'")).toEqual([])

		expect(await store.gc?.()).toEqual({ reclaimed: 0, done: true })
		expect(db.query("SELECT value FROM meta WHERE key = 'feed_floor'")[0]?.value).toBe('2')
		expect(db.query("SELECT value FROM meta WHERE key = 'pending_fence'")).toHaveLength(1)
	})

	it('keeps the fenced tombstone authoritative throughout grace', async () => {
		let now = 0
		const policy = syncPolicy({
			cursorLeaseMs: 100,
			writeLeaseMs: 20,
			maxWriteDurationMs: 10,
			tombstoneFenceAgeMs: 100,
			tombstoneGraceMs: 31
		})
		const lock = syncStateLock()
		const raw = sqliteStore(adapter(new DatabaseSync(':memory:')), undefined, {
			clock: () => now,
			lock,
			policy
		})
		await raw.commit([node('gone')])
		now = 101
		const peer = receiver(authority(raw) as ReceiverStore, { clock: () => now, lock, policy })
		const first = await peer.since()
		const cursor = (await peer.since(first.next)).next
		const lease = await peer.open(cursor)

		await raw.gc?.()
		await expect(peer.commit(lease, [node('gone', false)])).rejects.toThrow(GuardError)
		expect(await raw.get('gone')).toEqual(node('gone'))
	})

	it('rejects a grace window that cannot outlive a lease and request', () => {
		expect(() =>
			syncPolicy({
				writeLeaseMs: 20,
				maxWriteDurationMs: 10,
				tombstoneGraceMs: 30
			})
		).toThrow('tombstoneGraceMs')
	})

	it('deletes the fenced boundary in bounded batches after one grace period', async () => {
		let now = 0
		const db = adapter(new DatabaseSync(':memory:'))
		const store = sqliteStore(db, undefined, {
			clock: () => now,
			policy: {
				cursorLeaseMs: 100,
				writeLeaseMs: 20,
				maxWriteDurationMs: 10,
				tombstoneFenceAgeMs: 100,
				tombstoneGraceMs: 31,
				deleteBatch: 2
			}
		})
		await store.commit(['a', 'b', 'c', 'd'].map((id) => node(id)))
		now = 1_000

		// A late first sweep still establishes a real grace barrier and deletes nothing.
		expect(await store.gc?.()).toEqual({ reclaimed: 0, done: true })
		expect((await rows(store)).filter((row) => row.deleted)).toHaveLength(4)
		now += 30
		expect(await store.gc?.()).toEqual({ reclaimed: 0, done: true })

		now++
		expect(await store.gc?.()).toEqual({ reclaimed: 2, done: false })
		expect(await store.gc?.()).toEqual({ reclaimed: 2, done: true })
		expect((await rows(store)).filter((row) => row.deleted)).toEqual([])
		expect(db.query("SELECT value FROM meta WHERE key = 'pending_fence'")).toEqual([])
	})

	it('does not fence locally authored work until every outbound cursor passes it', async () => {
		let now = 0
		let acknowledged: string | undefined
		const lock = syncStateLock()
		const db = adapter(new DatabaseSync(':memory:'))
		const store = sqliteStore(db, undefined, {
			clock: () => now,
			lock,
			outboundCursors: async () => [acknowledged],
			policy: {
				cursorLeaseMs: 100,
				writeLeaseMs: 20,
				maxWriteDurationMs: 10,
				tombstoneFenceAgeMs: 100,
				tombstoneGraceMs: 31
			}
		})
		acknowledged = (await store.since()).next
		await store.commit([node('unpushed')])
		now = 101

		expect(await store.gc?.()).toEqual({ reclaimed: 0, done: true })
		expect(db.query("SELECT value FROM meta WHERE key = 'pending_fence'")).toEqual([])

		await lock(async () => {
			acknowledged = (await store.since(acknowledged)).next
		})
		expect(await store.gc?.()).toEqual({ reclaimed: 0, done: true })
		expect(db.query("SELECT value FROM meta WHERE key = 'feed_floor'")[0]?.value).toBe('2')
	})

	it('retains a fenced range while an outbound cursor is empty or rewound', async () => {
		let now = 0
		let acknowledged: string | undefined
		const lock = syncStateLock()
		const store = sqliteStore(adapter(new DatabaseSync(':memory:')), undefined, {
			clock: () => now,
			lock,
			outboundCursors: async () => [acknowledged],
			policy: {
				cursorLeaseMs: 100,
				writeLeaseMs: 20,
				maxWriteDurationMs: 10,
				tombstoneFenceAgeMs: 100,
				tombstoneGraceMs: 31
			}
		})
		await store.commit([node('held')])
		acknowledged = (await store.since()).next
		now = 101
		await store.gc?.()
		now = 132
		await lock(async () => {
			acknowledged = undefined
		})

		expect(await store.gc?.()).toEqual({ reclaimed: 0, done: true })
		expect(await store.get('held')).toEqual(node('held'))

		await lock(async () => {
			acknowledged = (await store.since()).next
		})
		expect(await store.gc?.()).toEqual({ reclaimed: 1, done: true })
		expect(await store.get('held')).toBeNull()
	})

	it('holds the sync-state lock from acknowledgement read through deletion', async () => {
		let now = 0
		let acknowledged: string | undefined
		let pauseRead = false
		const read = deferred()
		const release = deferred()
		const lock = syncStateLock()
		const store = sqliteStore(adapter(new DatabaseSync(':memory:')), undefined, {
			clock: () => now,
			lock,
			outboundCursors: async () => {
				if (pauseRead) {
					read.resolve()
					await release.promise
				}
				return [acknowledged]
			},
			policy: {
				cursorLeaseMs: 100,
				writeLeaseMs: 20,
				maxWriteDurationMs: 10,
				tombstoneFenceAgeMs: 100,
				tombstoneGraceMs: 31
			}
		})
		await store.commit([node('held')])
		acknowledged = (await store.since()).next
		now = 101
		await store.gc?.()
		now = 132
		pauseRead = true

		const deleting = store.gc?.()
		await read.promise
		let resetRan = false
		const resetting = lock(async () => {
			resetRan = true
			acknowledged = undefined
		})
		await Promise.resolve()
		expect(resetRan).toBe(false)
		release.resolve()
		expect(await deleting).toEqual({ reclaimed: 1, done: true })
		await resetting
		expect(resetRan).toBe(true)
		expect(await store.get('held')).toBeNull()
	})

	it('never reuses the swept feed tail behind an issued cursor', async () => {
		let now = 0
		const store = sqliteStore(adapter(new DatabaseSync(':memory:')), undefined, {
			clock: () => now,
			policy: {
				cursorLeaseMs: 100,
				writeLeaseMs: 20,
				maxWriteDurationMs: 10,
				tombstoneFenceAgeMs: 100,
				tombstoneGraceMs: 31
			}
		})
		await store.commit([node('tail')])
		const issued = (await store.since()).next
		now = 101
		await store.gc?.()
		now = 132
		await store.gc?.()
		await store.commit([node('news', false)])

		expect((await store.since(issued)).nodes.map((row) => row.id)).toEqual(['news'])
	})

	it('persists cursor signing state across reopen and rotates it on reset', async () => {
		const db = adapter(new DatabaseSync(':memory:'))
		const before = receiver(sqliteStore(db))
		const first = await before.since()
		const cursor = (await before.since(first.next)).next

		await expect(receiver(sqliteStore(db)).since(cursor)).resolves.toMatchObject({ nodes: [] })
		db.transactionSync(() => emptyStore(db))
		await expect(receiver(sqliteStore(db)).since(cursor)).rejects.toThrow(BootstrapRequiredError)
	})
})
