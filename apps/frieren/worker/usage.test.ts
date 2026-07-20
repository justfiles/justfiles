import { DatabaseSync } from 'node:sqlite'
import type { Usage } from '@earendil-works/pi-ai'
import type { DbAdapter } from '@justfiles/core'
import { describe, expect, test } from 'vitest'
import type { KvStorage } from './integrations/storage.ts'
import { type AiUsage, accrueAi, readAiUsage, readUsage } from './usage.ts'

function memKv(): KvStorage {
	const map = new Map<string, unknown>()
	return {
		async get<T>(key: string) {
			return map.get(key) as T | undefined
		},
		async put<T>(key: string, value: T) {
			map.set(key, value)
		},
		async delete(key: string) {
			return map.delete(key)
		},
		async list<T>() {
			return new Map(map) as Map<string, T>
		}
	}
}

function usage(cost: number): Usage {
	return {
		input: 10,
		output: 20,
		cacheRead: 1,
		cacheWrite: 2,
		totalTokens: 30,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost }
	}
}

// A DbAdapter that answers the fs_contents aggregate with fixed rows.
function fakeDb(rows: Array<{ storage_kind: number; bytes: number; n: number }>): DbAdapter {
	return {
		async query<T extends Record<string, unknown>>() {
			return rows as unknown as T[]
		},
		async run() {},
		async transaction(fn) {
			await fn(this as unknown as DbAdapter)
		}
	} as DbAdapter
}

// A real in-memory SQLite DbAdapter over just the two tables readUsage aggregates, to
// exercise the actual query (the fake above ignores the SQL). node:sqlite is synchronous.
function realDb(): DbAdapter {
	const db = new DatabaseSync(':memory:')
	db.exec(
		`CREATE TABLE fs_inodes (content_hash TEXT);
		 CREATE TABLE fs_contents (content_hash TEXT, storage_kind INTEGER, size INTEGER);`
	)
	return {
		async query<T extends Record<string, unknown>>(sql: string) {
			return db.prepare(sql).all() as unknown as T[]
		},
		async run(sql: string) {
			db.exec(sql)
		},
		async transaction(fn) {
			await fn(this as unknown as DbAdapter)
		}
	} as DbAdapter
}

describe('accrueAi', () => {
	test('sums windowed counters and lifetime totals across calls', async () => {
		const kv = memKv()
		await accrueAi(kv, usage(0.5))
		await accrueAi(kv, usage(0.25))

		const ai = await kv.get<AiUsage>('usage/ai')
		expect(ai?.requests).toBe(2)
		expect(ai?.totalTokens).toBe(60)
		expect(ai?.costUsd).toBeCloseTo(0.75)
		expect(ai?.lifetimeRequests).toBe(2)
		expect(ai?.lifetimeCostUsd).toBeCloseTo(0.75)
	})

	test('rolls the monthly window but carries lifetime totals forward', async () => {
		const kv = memKv()
		await accrueAi(kv, usage(1))
		// Simulate a prior-month row still in storage.
		const cur = await kv.get<AiUsage>('usage/ai')
		if (!cur) throw new Error('expected row')
		await kv.put('usage/ai', { ...cur, window: '1999-01' })

		await accrueAi(kv, usage(2))

		const ai = await kv.get<AiUsage>('usage/ai')
		expect(ai?.window).not.toBe('1999-01')
		// Windowed counters reset to just the new call...
		expect(ai?.requests).toBe(1)
		expect(ai?.costUsd).toBeCloseTo(2)
		// ...while lifetime totals accumulate across the roll.
		expect(ai?.lifetimeRequests).toBe(2)
		expect(ai?.lifetimeCostUsd).toBeCloseTo(3)
	})
})

describe('readAiUsage', () => {
	test('rolls a stale prior-month counter to a zeroed current window on READ', async () => {
		const kv = memKv()
		// A prior month that hit the cap, never re-accrued (the account was blocked).
		await accrueAi(kv, usage(5))
		const cur = await kv.get<AiUsage>('usage/ai')
		if (!cur) throw new Error('expected row')
		await kv.put('usage/ai', { ...cur, window: '1999-01' })

		// Reading (the pre-turn gate's path) must see a fresh, zeroed window — not the
		// stale over-cap counter — so the account isn't blocked forever.
		const ai = await readAiUsage(kv)
		expect(ai.window).not.toBe('1999-01')
		expect(ai.costUsd).toBe(0)
		expect(ai.requests).toBe(0)
		// Lifetime totals still carry forward.
		expect(ai.lifetimeCostUsd).toBeCloseTo(5)
		expect(ai.lifetimeRequests).toBe(1)
	})
})

describe('readUsage', () => {
	test('splits logical storage into inline vs r2 and echoes physical bytes', async () => {
		const kv = memKv()
		const db = fakeDb([
			{ storage_kind: 1, bytes: 400, n: 3 },
			{ storage_kind: 2, bytes: 600, n: 2 }
		])

		const report = await readUsage(kv, db, 4096)

		expect(report.storage).toEqual({
			logicalBytes: 1000,
			blobCount: 5,
			inlineBytes: 400,
			r2Bytes: 600,
			physicalBytes: 4096
		})
		// No accrual yet → a zeroed AI counter for the current window.
		expect(report.ai.requests).toBe(0)
		expect(report.ai.window).toMatch(/^\d{4}-\d{2}$/)
	})

	test('counts only inode-referenced blobs, excluding orphaned fs_contents rows', async () => {
		const kv = memKv()
		const db = realDb()
		// Two inodes reference hash 'a' (dedup: counts once); 'orphan' is in fs_contents but
		// referenced by no inode (an interrupted push / out-of-band-GC leftover).
		await db.run("INSERT INTO fs_inodes(content_hash) VALUES ('a'), ('a'), ('b')")
		await db.run(
			`INSERT INTO fs_contents(content_hash, storage_kind, size) VALUES
			 ('a', 1, 100), ('b', 2, 200), ('orphan', 2, 999)`
		)

		const report = await readUsage(kv, db, 0)

		// 'orphan' (999) excluded; 'a' counted once despite two inode refs.
		expect(report.storage.logicalBytes).toBe(300)
		expect(report.storage.blobCount).toBe(2)
		expect(report.storage.inlineBytes).toBe(100)
		expect(report.storage.r2Bytes).toBe(200)
	})
})
