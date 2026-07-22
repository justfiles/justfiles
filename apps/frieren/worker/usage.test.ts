import { DatabaseSync } from 'node:sqlite'
import type { Usage } from '@earendil-works/pi-ai'
import type { DbAdapter, SqlValue } from '@justfiles/core'
import { describe, expect, test } from 'vitest'
import {
	BURST_WINDOW_MS,
	ensureUsageSchema,
	MICROS_PER_USD,
	readAiUsage,
	readUsage,
	release,
	reserve,
	settle
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

async function reserved(db: DbAdapter): Promise<{ burst: number; weekly: number }> {
	const [row] = await db.query<{ burst_reserved: unknown; weekly_reserved: unknown }>(
		'SELECT burst_reserved, weekly_reserved FROM usage_ai WHERE id = 1'
	)
	return { burst: Number(row?.burst_reserved ?? 0), weekly: Number(row?.weekly_reserved ?? 0) }
}

const DOLLAR = MICROS_PER_USD
const EST = 100_000 // $0.10 reservation used in these tests
const WEEK = 7 * 24 * 60 * 60 * 1000
const T0 = Date.UTC(2025, 0, 6, 12) // Monday noon UTC — safely mid weekly-bucket
const HUGE = 1000 * DOLLAR

describe('reserve / settle', () => {
	test('settle records actual cost + tokens + a request in both windows', async () => {
		const db = realDb()
		await ensureUsageSchema(db)
		const h = await reserve(db, T0, EST, 5 * DOLLAR, 10 * DOLLAR)
		expect(h).not.toBeNull()
		await settle(db, h!, EST, usage(0.5, 120))

		const ai = await readAiUsage(db, T0)
		expect(ai.burst.costUsd).toBeCloseTo(0.5)
		expect(ai.weekly.costUsd).toBeCloseTo(0.5)
		expect(ai.totalTokens).toBe(120)
		expect(ai.requests).toBe(1)
		expect(ai.lifetimeCostUsd).toBeCloseTo(0.5)
		expect(ai.lifetimeRequests).toBe(1)
		expect(await reserved(db)).toEqual({ burst: 0, weekly: 0 })
	})

	test('the burst cap rejects even when the weekly cap has room', async () => {
		const db = realDb()
		await ensureUsageSchema(db)
		const h = await reserve(db, T0, EST, 5 * DOLLAR, HUGE)
		await settle(db, h!, EST, usage(4.99)) // burst committed near its $5 cap
		expect(await reserve(db, T0, EST, 5 * DOLLAR, HUGE)).toBeNull()
		expect(await reserve(db, T0, EST, 6 * DOLLAR, HUGE)).not.toBeNull()
	})

	test('the weekly cap rejects even when the burst cap has room', async () => {
		const db = realDb()
		await ensureUsageSchema(db)
		const h = await reserve(db, T0, EST, HUGE, 5 * DOLLAR)
		await settle(db, h!, EST, usage(4.99)) // weekly committed near its $5 cap
		expect(await reserve(db, T0, EST, HUGE, 5 * DOLLAR)).toBeNull()
		expect(await reserve(db, T0, EST, HUGE, 6 * DOLLAR)).not.toBeNull()
	})

	test('concurrent reservations accumulate so they cannot all pass one below-cap read', async () => {
		const db = realDb()
		await ensureUsageSchema(db)
		// $0.05 burst cap, $0.02 reserve each: admissions are bounded even with nothing settled.
		const admits = await Promise.all(
			Array.from({ length: 20 }, () => reserve(db, T0, 20_000, 50_000, HUGE))
		)
		const passed = admits.filter((h) => h !== null).length
		expect(passed).toBeGreaterThan(0)
		expect(passed).toBeLessThan(20)
	})

	test('release frees reservations in both windows without counting a request', async () => {
		const db = realDb()
		await ensureUsageSchema(db)
		const h = await reserve(db, T0, EST, 5 * DOLLAR, 5 * DOLLAR)
		await release(db, h!, EST)
		const ai = await readAiUsage(db, T0)
		expect(ai.requests).toBe(0)
		expect(ai.burst.costUsd).toBe(0)
		expect(await reserved(db)).toEqual({ burst: 0, weekly: 0 })
		expect(await reserve(db, T0, EST, 5 * DOLLAR, 5 * DOLLAR)).not.toBeNull()
	})
})

describe('window rolls', () => {
	test('the burst window rolls after BURST_WINDOW_MS; weekly spend persists', async () => {
		const db = realDb()
		await ensureUsageSchema(db)
		const h = await reserve(db, T0, EST, 5 * DOLLAR, HUGE)
		await settle(db, h!, EST, usage(0.5))

		// Inside the burst window: still counted.
		let ai = await readAiUsage(db, T0 + 60_000)
		expect(ai.burst.costUsd).toBeCloseTo(0.5)
		expect(ai.burst.resetsAt).toBe(T0 + BURST_WINDOW_MS)

		// Past expiry: burst reads as a fresh empty window, weekly keeps the spend.
		ai = await readAiUsage(db, T0 + BURST_WINDOW_MS + 1)
		expect(ai.burst.costUsd).toBe(0)
		expect(ai.burst.resetsAt).toBeNull()
		expect(ai.weekly.costUsd).toBeCloseTo(0.5)

		// A reserve in the new burst window rolls the row and anchors a fresh 5h expiry.
		const later = T0 + BURST_WINDOW_MS + 1
		const h2 = await reserve(db, later, EST, 5 * DOLLAR, HUGE)
		expect(h2).not.toBeNull()
		expect(h2!.burstExpires).toBe(later + BURST_WINDOW_MS)
	})

	test('the weekly window rolls at the week boundary; lifetime carried', async () => {
		const db = realDb()
		await ensureUsageSchema(db)
		const h = await reserve(db, T0, EST, HUGE, 5 * DOLLAR)
		await settle(db, h!, EST, usage(0.5, 10))

		const ai = await readAiUsage(db, T0 + WEEK)
		expect(ai.weekly.costUsd).toBe(0)
		expect(ai.totalTokens).toBe(0)
		expect(ai.requests).toBe(0)
		expect(ai.lifetimeCostUsd).toBeCloseTo(0.5)
		expect(ai.lifetimeRequests).toBe(1)
		// A full weekly budget is available again next week.
		expect(await reserve(db, T0 + WEEK, EST, HUGE, 5 * DOLLAR)).not.toBeNull()
	})

	test('a late settle whose burst window rolled cannot touch the new burst window', async () => {
		const db = realDb()
		await ensureUsageSchema(db)
		const h1 = await reserve(db, T0, EST, HUGE, HUGE)
		// A later call (same week, new burst window) holds its own reservation.
		const later = T0 + BURST_WINDOW_MS + 1
		const h2 = await reserve(db, later, EST, HUGE, HUGE)
		expect(h2!.burstExpires).not.toBe(h1!.burstExpires)
		const before = await reserved(db)

		// The straggler settles late against the OLD burst window.
		await settle(db, h1!, EST, usage(0.5, 10))

		const after = await readAiUsage(db, later)
		// Burst committed unaffected (old window discarded); weekly is the SAME bucket → credited.
		expect(after.burst.costUsd).toBe(0)
		expect(after.weekly.costUsd).toBeCloseTo(0.5)
		// The old burst reservation was NOT subtracted from the new burst window.
		expect((await reserved(db)).burst).toBe(before.burst)
		// Lifetime still accrues.
		expect(after.lifetimeCostUsd).toBeCloseTo(0.5)
	})
})

describe('ensureUsageSchema migration', () => {
	test('adds burst/weekly columns to a legacy monthly table, carrying lifetime totals', async () => {
		const db = realDb()
		// The pre-dual-window schema: a single monthly window row.
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
		expect(await reserve(db, T0, EST, 5 * DOLLAR, 5 * DOLLAR)).not.toBeNull()
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
