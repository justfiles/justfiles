/**
 * G01–G04: tombstone fence and bounded deletion on the leased SQLite store.
 */

import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import { DEFAULT_SYNC_POLICY, days, type SyncPolicy } from '@justfiles/fs/sync-policy'
import { ROOT, type Node } from '@justfiles/fs/store'
import { createSqliteSyncDb } from './db.sqlite'
import { sqliteLeasedStore } from './leased-sqlite'

const adapter = (db: DatabaseSync) =>
	createSqliteSyncDb(db as unknown as Parameters<typeof createSqliteSyncDb>[0])

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
		let push = 100
		let now = 1_700_000_000_000
		const store = await sqliteLeasedStore(db, 'main', {
			policy: testPolicy(),
			pushCursor: async () => push,
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

describe('G04 delayed inclusive deletion', () => {
	test('after grace, bounded batches drain through and clear checkpoint', async () => {
		const db = adapter(new DatabaseSync(':memory:'))
		let push = 100
		let now = 1_700_000_000_000
		const store = await sqliteLeasedStore(db, 'main', {
			policy: testPolicy({ deleteBatch: 3 }),
			pushCursor: async () => push,
			clock: { now: () => now, tick: (v) => (now = Math.max(now, v)) }
		})
		for (let i = 0; i < 7; i++) await store.localCommit([tomb(`t${i}`, `t${i}.txt`)])
		now += days(31)
		await store.gc()
		now += days(1)
		let total = 0
		for (;;) {
			const pass = await store.gc()
			total += pass.reclaimed
			if (pass.done && pass.reclaimed === 0) break
		}
		expect(total).toBe(7)
		expect(store.ctx.state.pendingFence).toBeNull()
	})
})

describe('G07 retain unpushed work', () => {
	test('tombstone at or after push cursor is not fenced', async () => {
		const db = adapter(new DatabaseSync(':memory:'))
		let push = 0
		let now = 1_700_000_000_000
		const store = await sqliteLeasedStore(db, 'main', {
			policy: testPolicy(),
			pushCursor: async () => push,
			clock: { now: () => now, tick: (v) => (now = Math.max(now, v)) }
		})
		await store.localCommit([tomb('old', 'old.txt')])
		await store.localCommit([tomb('new', 'new.txt')])
		push = 2 // ack through seq 1; seq 2 remains unacknowledged
		now += days(31)
		await store.gc()
		expect(store.ctx.state.pendingFence?.through).toBe(1)
	})
})

describe('G10 monotonic head', () => {
	test('feed head never reuses a deleted tombstone seq', async () => {
		const db = adapter(new DatabaseSync(':memory:'))
		let push = 100
		let now = 1_700_000_000_000
		const store = await sqliteLeasedStore(db, 'main', {
			policy: testPolicy({ deleteBatch: 10 }),
			pushCursor: async () => push,
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
