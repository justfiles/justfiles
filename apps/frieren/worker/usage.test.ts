import { DatabaseSync } from 'node:sqlite'
import type { Usage } from '@earendil-works/pi-ai'
import type { DbAdapter, SqlValue } from '@justfiles/core'
import { describe, expect, test } from 'vitest'
import {
	admit,
	BURST_WINDOW_MS,
	ensureUsageSchema,
	MICROS_PER_USD,
	readAiUsage,
	readUsage,
	record
} from './usage.ts'

// A real in-memory SQLite DbAdapter (node:sqlite is synchronous) — the usage store is pure
// SQL, so we exercise the actual statements rather than faking rows.
function realDb(): DbAdapter {
	const db = new DatabaseSync(':memory:')
	db.exec(
		`CREATE TABLE fs_inodes (content_hash TEXT);
		 CREATE TABLE fs_contents (content_hash TEXT, storage_kind INTEGER, size INTEGER);`
	)
	const adapter: DbAdapter = {
		async query<T extends Record<string, unknown>>(sql: string, args: SqlValue[] = []) {
			return db.prepare(sql).all(...(args as (string | number | bigint | null)[])) as unknown as T[]
		},
		async run(sql: string, args: SqlValue[] = []) {
			db.prepare(sql).run(...(args as (string | number | bigint | null)[]))
		},
		async transaction(fn) {
			await fn(adapter)
		}
	}
	return adapter
}

function usage(costUsd: number, tokens = 0): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: tokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costUsd }
	}
}

const DOLLAR = MICROS_PER_USD
const WEEK = 7 * 24 * 60 * 60 * 1000
const T0 = Date.UTC(2025, 0, 6, 12) // Monday noon UTC — safely mid weekly-bucket
const HUGE = 1000 * DOLLAR

describe('admit / record', () => {
	test('record adds actual cost + tokens + a request in both windows', async () => {
		const db = realDb()
		await ensureUsageSchema(db)
		const h = await admit(db, T0, 5 * DOLLAR, 10 * DOLLAR)
		expect(h).not.toBeNull()
		await record(db, h!, usage(0.5, 120))

		const ai = await readAiUsage(db, T0)
		expect(ai.burst.costUsd).toBeCloseTo(0.5)
		expect(ai.weekly.costUsd).toBeCloseTo(0.5)
		expect(ai.totalTokens).toBe(120)
		expect(ai.requests).toBe(1)
		expect(ai.lifetimeCostUsd).toBeCloseTo(0.5)
		expect(ai.lifetimeRequests).toBe(1)
	})

	test('the burst cap blocks even when the weekly cap has room', async () => {
		const db = realDb()
		await ensureUsageSchema(db)
		const h = await admit(db, T0, 5 * DOLLAR, HUGE)
		await record(db, h!, usage(5)) // burst committed at its $5 cap
		expect(await admit(db, T0, 5 * DOLLAR, HUGE)).toBeNull()
		expect(await admit(db, T0, 6 * DOLLAR, HUGE)).not.toBeNull()
	})

	test('the weekly cap blocks even when the burst cap has room', async () => {
		const db = realDb()
		await ensureUsageSchema(db)
		const h = await admit(db, T0, HUGE, 5 * DOLLAR)
		await record(db, h!, usage(5)) // weekly committed at its $5 cap
		expect(await admit(db, T0, HUGE, 5 * DOLLAR)).toBeNull()
		expect(await admit(db, T0, HUGE, 6 * DOLLAR)).not.toBeNull()
	})

	test('an admitted call may overshoot the cap; the next call is then blocked', async () => {
		const db = realDb()
		await ensureUsageSchema(db)
		// Just under the $1 burst cap → admitted, then a pricey call pushes committed over.
		const h = await admit(db, T0, 1 * DOLLAR, HUGE)
		expect(h).not.toBeNull()
		await record(db, h!, usage(1.5))
		expect((await readAiUsage(db, T0)).burst.costUsd).toBeCloseTo(1.5)
		// committed ($1.5) is now ≥ the cap, so the next call is blocked.
		expect(await admit(db, T0, 1 * DOLLAR, HUGE)).toBeNull()
	})

	test('a failed call records nothing (no handle → no cost)', async () => {
		const db = realDb()
		await ensureUsageSchema(db)
		const h = await admit(db, T0, 5 * DOLLAR, 5 * DOLLAR)
		expect(h).not.toBeNull()
		// No record() call (the call failed before producing usage).
		const ai = await readAiUsage(db, T0)
		expect(ai.burst.costUsd).toBe(0)
		expect(ai.requests).toBe(0)
		expect(await admit(db, T0, 5 * DOLLAR, 5 * DOLLAR)).not.toBeNull()
	})
})

describe('window rolls', () => {
	test('the burst window rolls after BURST_WINDOW_MS; weekly spend persists', async () => {
		const db = realDb()
		await ensureUsageSchema(db)
		const h = await admit(db, T0, 5 * DOLLAR, HUGE)
		await record(db, h!, usage(0.5))

		// Inside the burst window: still counted.
		let ai = await readAiUsage(db, T0 + 60_000)
		expect(ai.burst.costUsd).toBeCloseTo(0.5)
		expect(ai.burst.resetsAt).toBe(T0 + BURST_WINDOW_MS)

		// Past expiry: burst reads as a fresh empty window, weekly keeps the spend.
		ai = await readAiUsage(db, T0 + BURST_WINDOW_MS + 1)
		expect(ai.burst.costUsd).toBe(0)
		expect(ai.burst.resetsAt).toBeNull()
		expect(ai.weekly.costUsd).toBeCloseTo(0.5)

		// An admit in the new burst window rolls the row and anchors a fresh 5h expiry.
		const later = T0 + BURST_WINDOW_MS + 1
		const h2 = await admit(db, later, 5 * DOLLAR, HUGE)
		expect(h2).not.toBeNull()
		expect(h2!.burstExpires).toBe(later + BURST_WINDOW_MS)
	})

	test('the weekly window rolls at the week boundary; lifetime carried', async () => {
		const db = realDb()
		await ensureUsageSchema(db)
		const h = await admit(db, T0, HUGE, 5 * DOLLAR)
		await record(db, h!, usage(0.5, 10))

		const ai = await readAiUsage(db, T0 + WEEK)
		expect(ai.weekly.costUsd).toBe(0)
		expect(ai.totalTokens).toBe(0)
		expect(ai.requests).toBe(0)
		expect(ai.lifetimeCostUsd).toBeCloseTo(0.5)
		expect(ai.lifetimeRequests).toBe(1)
		// A full weekly budget is available again next week.
		expect(await admit(db, T0 + WEEK, HUGE, 5 * DOLLAR)).not.toBeNull()
	})

	test('a late record whose burst window rolled cannot credit the new burst window', async () => {
		const db = realDb()
		await ensureUsageSchema(db)
		const h1 = await admit(db, T0, HUGE, HUGE)
		// A later call (same week, new burst window) is admitted.
		const later = T0 + BURST_WINDOW_MS + 1
		const h2 = await admit(db, later, HUGE, HUGE)
		expect(h2!.burstExpires).not.toBe(h1!.burstExpires)

		// The straggler records late against the OLD burst window.
		await record(db, h1!, usage(0.5, 10))

		const after = await readAiUsage(db, later)
		// Burst committed unaffected (old window discarded); weekly is the SAME bucket → credited.
		expect(after.burst.costUsd).toBe(0)
		expect(after.weekly.costUsd).toBeCloseTo(0.5)
		// Lifetime still accrues.
		expect(after.lifetimeCostUsd).toBeCloseTo(0.5)
	})
})

describe('ensureUsageSchema migration', () => {
	test('adds burst/weekly columns to a legacy monthly table, carrying lifetime totals', async () => {
		const db = realDb()
		// The pre-dual-window schema: a single monthly window row with a reservation column.
		await db.run(
			`CREATE TABLE usage_ai (
				id INTEGER PRIMARY KEY,
				window TEXT NOT NULL,
				committed_micros INTEGER NOT NULL DEFAULT 0,
				reserved_micros INTEGER NOT NULL DEFAULT 0,
				tokens INTEGER NOT NULL DEFAULT 0,
				requests INTEGER NOT NULL DEFAULT 0,
				lifetime_micros INTEGER NOT NULL DEFAULT 0,
				lifetime_requests INTEGER NOT NULL DEFAULT 0
			)`
		)
		await db.run(
			"INSERT INTO usage_ai (id, window, lifetime_micros, lifetime_requests) VALUES (1, '2025-01', 1500000, 7)"
		)

		await ensureUsageSchema(db)

		const ai = await readAiUsage(db, T0)
		expect(ai.lifetimeCostUsd).toBeCloseTo(1.5)
		expect(ai.lifetimeRequests).toBe(7)
		expect(ai.burst.costUsd).toBe(0)
		expect(ai.weekly.costUsd).toBe(0)
		// The gate works against the migrated row under a tiny burst cap.
		expect(await admit(db, T0, 5 * DOLLAR, 5 * DOLLAR)).not.toBeNull()
	})
})

describe('readUsage storage', () => {
	test('counts only inode-referenced blobs, excluding orphaned fs_contents rows', async () => {
		const db = realDb()
		await ensureUsageSchema(db)
		// Two inodes reference hash 'a' (dedup: counts once); 'orphan' has no inode reference.
		await db.run("INSERT INTO fs_inodes(content_hash) VALUES ('a'), ('a'), ('b')")
		await db.run(
			`INSERT INTO fs_contents(content_hash, storage_kind, size) VALUES
			 ('a', 1, 100), ('b', 2, 200), ('orphan', 2, 999)`
		)

		const report = await readUsage(db, 4096, T0)

		expect(report.storage).toEqual({
			logicalBytes: 300,
			blobCount: 2,
			inlineBytes: 100,
			r2Bytes: 200,
			physicalBytes: 4096
		})
		expect(report.ai.weekly.resetsAt).toBeGreaterThan(0)
	})
})
