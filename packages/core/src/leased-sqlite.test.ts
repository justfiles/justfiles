/**
 * G01–G04: tombstone fence and bounded deletion on the leased SQLite store.
 */

import { DatabaseSync } from 'node:sqlite'
import { mutexLock } from '@justfiles/fs/lease'
import { memStore } from '@justfiles/fs/mem'
import { type Node, ROOT } from '@justfiles/fs/store'
import { DEFAULT_SYNC_POLICY, days, type SyncPolicy } from '@justfiles/fs/sync-policy'
import { bootstrap } from '@justfiles/fs/synced'
import { describe, expect, test } from 'vitest'
import { createSqliteSyncDb } from './db.sqlite'
import { sqliteLeasedStore as createLeasedStore, type SqliteLeasedOpts } from './leased-sqlite'
import { emptyStore, sqliteStore } from './store.sqlite'

const adapter = (db: DatabaseSync) =>
	createSqliteSyncDb(db as unknown as Parameters<typeof createSqliteSyncDb>[0])

const sqliteLeasedStore = async (
	db: ReturnType<typeof adapter>,
	id: string,
	opts: SqliteLeasedOpts
) => {
	await sqliteStore(db, id).get(ROOT)
	return createLeasedStore(db, id, opts)
}

const cursorAt = (db: ReturnType<typeof adapter>, position: number): string => {
	const [row] = db.query<{ lineage: unknown }>(
		"SELECT meta.value AS lineage FROM meta JOIN stores ON stores.sid = meta.sid WHERE stores.id = 'main' AND meta.key = 'lineage'"
	)
	return `${String(row?.lineage)}${String.fromCharCode(0)}${position}`
}

const tomb = (id: string, name: string): Node => ({
	id,
	parent: ROOT,
	name,
	type: 'file',
	mode: 0o100644,
	mtimeNs: 0n,
	size: 0n,
	version: `t:${id}`,
	deleted: true
})

const live = (id: string, name: string): Node => ({
	id,
	parent: ROOT,
	name,
	type: 'file',
	mode: 0o100644,
	mtimeNs: 0n,
	size: 0n,
	version: `l:${id}`
})

const testPolicy = (over: Partial<SyncPolicy> = {}): SyncPolicy => ({
	...DEFAULT_SYNC_POLICY,
	cursorLeaseMs: days(30),
	tombstoneFenceAgeMs: days(30),
	tombstoneGraceMs: days(1),
	deleteBatch: 4,
	writeLeaseMs: 60_000,
	maxWriteDurationMs: 30_000,
	...over
})

describe('G01 fence full range', () => {
	test('many old tombstones fence in one checkpoint; rows stay until grace', async () => {
		const db = adapter(new DatabaseSync(':memory:'))
		let now = 1_700_000_000_000
		const store = await sqliteLeasedStore(db, 'main', {
			policy: testPolicy(),
			clock: { now: () => now, tick: (v) => (now = Math.max(now, v)) }
		})
		for (let i = 0; i < 10; i++) await store.localCommit([tomb(`t${i}`, `t${i}.txt`)])
		now += days(31)
		const fenced = await store.gc()
		expect(fenced).toEqual({ reclaimed: 0, done: true })
		expect(store.ctx.state.pendingFence?.through).toBeGreaterThan(0)
		expect(store.ctx.state.feedFloor).toBe(store.ctx.state.pendingFence!.through + 1)
		const page = await store.since()
		expect(page.nodes.filter((n) => n.deleted).length).toBeGreaterThan(0)
	})
})

describe('G02 atomic fence', () => {
	test('a failed checkpoint write advances neither the floor nor the fence', async () => {
		const inner = adapter(new DatabaseSync(':memory:'))
		let fail = false
		const db = {
			...inner,
			exec(sql: string, args?: Parameters<typeof inner.exec>[1]) {
				if (fail && sql.includes('pending_fence')) throw new Error('disk full')
				inner.exec(sql, args)
			}
		}
		let now = 1_700_000_000_000
		const store = await sqliteLeasedStore(db, 'main', {
			policy: testPolicy(),
			clock: { now: () => now, tick: (value) => (now = Math.max(now, value)) }
		})
		await store.localCommit([tomb('old', 'old.txt')])
		now += days(31)
		fail = true

		await expect(store.gc()).rejects.toThrow('disk full')
		expect(store.ctx.state).toMatchObject({ feedFloor: 0, pendingFence: null })

		fail = false
		await store.gc()
		expect(store.ctx.state.feedFloor).toBe(2)
		expect(store.ctx.state.pendingFence).toMatchObject({ through: 1 })
	})
})

describe('G04 delayed inclusive deletion', () => {
	test('after grace, bounded batches drain through and clear checkpoint', async () => {
		const db = adapter(new DatabaseSync(':memory:'))
		let now = 1_700_000_000_000
		const store = await sqliteLeasedStore(db, 'main', {
			policy: testPolicy({ deleteBatch: 3 }),
			clock: { now: () => now, tick: (v) => (now = Math.max(now, v)) }
		})
		for (let i = 0; i < 7; i++) await store.localCommit([tomb(`t${i}`, `t${i}.txt`)])
		now += days(31)
		await store.gc()
		now += days(1)
		let total = 0
		const done: boolean[] = []
		for (;;) {
			const pass = await store.gc()
			total += pass.reclaimed
			done.push(pass.done)
			if (pass.done && pass.reclaimed === 0) break
		}
		expect(total).toBe(7)
		expect(done.slice(0, 2)).toEqual([false, false])
		expect(store.ctx.state.pendingFence).toBeNull()
	})
})

describe('G05 late first sweep', () => {
	test('age alone never skips the actual grace period', async () => {
		const db = adapter(new DatabaseSync(':memory:'))
		let now = 1_700_000_000_000
		const store = await sqliteLeasedStore(db, 'main', {
			policy: testPolicy({ deleteBatch: 10 }),
			clock: { now: () => now, tick: (value) => (now = Math.max(now, value)) }
		})
		await store.localCommit([tomb('old', 'old.txt')])
		now += days(100)

		expect(await store.gc()).toEqual({ reclaimed: 0, done: true })
		expect(await store.get('old')).not.toBeNull()
		now += days(1) - 1
		expect(await store.gc()).toEqual({ reclaimed: 0, done: true })
		expect(await store.get('old')).not.toBeNull()
		now += 1
		expect((await store.gc()).reclaimed).toBe(1)
		expect(await store.get('old')).toBeNull()
	})
})

describe('G07 retain unpushed work', () => {
	test('tombstone at or after push cursor is not fenced', async () => {
		const db = adapter(new DatabaseSync(':memory:'))
		let push: string | undefined
		let now = 1_700_000_000_000
		const store = await sqliteLeasedStore(db, 'main', {
			policy: testPolicy(),
			pushCursor: async () => push,
			clock: { now: () => now, tick: (v) => (now = Math.max(now, v)) }
		})
		await store.localCommit([tomb('old', 'old.txt')])
		await store.localCommit([tomb('new', 'new.txt')])
		push = cursorAt(db, 2) // ack through seq 1; seq 2 remains unacknowledged
		now += days(31)
		await store.gc()
		expect(store.ctx.state.pendingFence?.through).toBe(1)
	})
})

describe('G08 outbound rewind', () => {
	test('deletion waits until every rewound cursor passes the fence again', async () => {
		const db = adapter(new DatabaseSync(':memory:'))
		let push: string | undefined
		let now = 1_700_000_000_000
		const store = await sqliteLeasedStore(db, 'main', {
			policy: testPolicy({ deleteBatch: 10 }),
			pushCursor: async () => push,
			clock: { now: () => now, tick: (value) => (now = Math.max(now, value)) }
		})
		await store.localCommit([tomb('old', 'old.txt')])
		push = cursorAt(db, 2)
		now += days(31)
		await store.gc()
		push = undefined
		now += days(1)

		expect(await store.gc()).toEqual({ reclaimed: 0, done: true })
		expect(await store.get('old')).not.toBeNull()
		push = cursorAt(db, 2)
		expect((await store.gc()).reclaimed).toBe(1)
	})
})

describe('G09 reset/delete exclusion', () => {
	test('a cursor reset that wins the shared lock makes deletion retain the row', async () => {
		const db = adapter(new DatabaseSync(':memory:'))
		const lock = mutexLock()
		let push: string | undefined
		let now = 1_700_000_000_000
		const store = await sqliteLeasedStore(db, 'main', {
			lock,
			policy: testPolicy({ deleteBatch: 10 }),
			pushCursor: async () => push,
			clock: { now: () => now, tick: (value) => (now = Math.max(now, value)) }
		})
		await store.localCommit([tomb('old', 'old.txt')])
		push = cursorAt(db, 2)
		now += days(31)
		await store.gc()
		now += days(1)
		await lock.run(() => {
			push = undefined
		})

		expect(await store.gc()).toEqual({ reclaimed: 0, done: true })
		expect(await store.get('old')).not.toBeNull()
	})
})

describe('G10 monotonic head', () => {
	test('feed head never reuses a deleted tombstone seq', async () => {
		const db = adapter(new DatabaseSync(':memory:'))
		let now = 1_700_000_000_000
		const store = await sqliteLeasedStore(db, 'main', {
			policy: testPolicy({ deleteBatch: 10 }),
			clock: { now: () => now, tick: (v) => (now = Math.max(now, v)) }
		})
		await store.localCommit([tomb('tail', 'tail.txt')])
		const headBefore = store.ctx.state.feedHead
		now += days(31)
		await store.gc()
		now += days(1)
		while ((await store.gc()).reclaimed > 0);
		await store.localCommit([live('live', 'live.txt')])
		expect(store.ctx.state.feedHead).toBe(headBefore + 1)
		const rows: Node[] = []
		let cursor: string | undefined
		for (;;) {
			const page = await store.since(cursor)
			rows.push(...page.nodes)
			if (page.nodes.length === 0) break
			cursor = page.next
		}
		expect(rows.some((n) => n.id === 'live')).toBe(true)
	})
})

describe('L06 reset/commit exclusion', () => {
	test('reset first rotates the lineage and refuses the old lease without a row write', async () => {
		const db = adapter(new DatabaseSync(':memory:'))
		const lock = mutexLock()
		const store = await sqliteLeasedStore(db, 'main', { lock, policy: testPolicy() })
		const cursor = await bootstrap(memStore(), store)
		const lease = await store.open(cursor)

		await lock.run(() => db.transactionSync(() => emptyStore(db)))

		await expect(store.commit(lease, [live('late', 'late.txt')])).rejects.toThrow(
			'bootstrap required'
		)
		expect(await store.get('late')).toBeNull()
	})

	test('commit first lands before the reset, which then removes it', async () => {
		const db = adapter(new DatabaseSync(':memory:'))
		const lock = mutexLock()
		const store = await sqliteLeasedStore(db, 'main', { lock, policy: testPolicy() })
		const cursor = await bootstrap(memStore(), store)
		const lease = await store.open(cursor)

		await store.commit(lease, [live('first', 'first.txt')])
		expect(await store.get('first')).not.toBeNull()
		await lock.run(() => db.transactionSync(() => emptyStore(db)))

		expect(await store.get('first')).toBeNull()
	})
})
