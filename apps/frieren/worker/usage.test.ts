import { DatabaseSync } from 'node:sqlite'
import type { Usage } from '@earendil-works/pi-ai'
import type { DbAdapter, SqlValue } from '@justfiles/core'
import { describe, expect, test } from 'vitest'
import {
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

const DOLLAR = MICROS_PER_USD
const EST = 100_000 // $0.10 worst-case reservation used in these tests

describe('reserve / settle', () => {
	test('settle records actual cost + tokens + a request', async () => {
		const db = realDb()
		await ensureUsageSchema(db)
		expect(await reserve(db, EST, 5 * DOLLAR)).toBe(true)
		await settle(db, EST, usage(0.5, 120))

		const ai = await readAiUsage(db)
		expect(ai.costUsd).toBeCloseTo(0.5)
		expect(ai.totalTokens).toBe(120)
		expect(ai.requests).toBe(1)
		expect(ai.lifetimeCostUsd).toBeCloseTo(0.5)
		expect(ai.lifetimeRequests).toBe(1)
	})

	test('rejects once committed + reservation would exceed the limit', async () => {
		const db = realDb()
		await ensureUsageSchema(db)
		await reserve(db, EST, 5 * DOLLAR)
		await settle(db, EST, usage(0.99))
		// $0.99 committed; a fresh reservation needs headroom under the $1 cap → rejected.
		expect(await reserve(db, EST, 1 * DOLLAR)).toBe(false)
		// Under a $2 cap there's room again.
		expect(await reserve(db, EST, 2 * DOLLAR)).toBe(true)
	})

	test('concurrent reservations accumulate so they cannot all pass one below-cap read', async () => {
		const db = realDb()
		await ensureUsageSchema(db)
		// $0.05 cap, $0.10 worst-case reserve each: admissions are bounded even with nothing
		// settled yet (the pre-atomic-store race would have let them all through).
		const admits = await Promise.all(Array.from({ length: 20 }, () => reserve(db, 20_000, 50_000)))
		const passed = admits.filter(Boolean).length
		expect(passed).toBeGreaterThan(0)
		expect(passed).toBeLessThan(20)
	})

	test('release frees a reservation without counting a request', async () => {
		const db = realDb()
		await ensureUsageSchema(db)
		await reserve(db, EST, 5 * DOLLAR)
		await release(db, EST)
		const ai = await readAiUsage(db)
		expect(ai.requests).toBe(0)
		expect(ai.costUsd).toBe(0)
		// The freed reservation is available again.
		expect(await reserve(db, EST, 5 * DOLLAR)).toBe(true)
	})
})

describe('readAiUsage window roll', () => {
	test('a stale prior-month row reads as a zeroed window, lifetime carried', async () => {
		const db = realDb()
		await ensureUsageSchema(db)
		await reserve(db, EST, 5 * DOLLAR)
		await settle(db, EST, usage(0.5, 10))
		await db.run("UPDATE usage_ai SET window = '1999-01' WHERE id = 1")

		const ai = await readAiUsage(db)
		expect(ai.costUsd).toBe(0)
		expect(ai.requests).toBe(0)
		expect(ai.totalTokens).toBe(0)
		expect(ai.lifetimeCostUsd).toBeCloseTo(0.5)
		expect(ai.lifetimeRequests).toBe(1)

		// A reserve in the new window rolls the row (committed stays 0 for the fresh month).
		expect(await reserve(db, EST, 5 * DOLLAR)).toBe(true)
		expect((await readAiUsage(db)).costUsd).toBe(0)
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

		const report = await readUsage(db, 4096)

		expect(report.storage).toEqual({
			logicalBytes: 300,
			blobCount: 2,
			inlineBytes: 100,
			r2Bytes: 200,
			physicalBytes: 4096
		})
		expect(report.ai.window).toMatch(/^\d{4}-\d{2}$/)
	})
})
