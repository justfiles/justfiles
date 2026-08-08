import { DatabaseSync } from 'node:sqlite'
import type { Usage } from '@earendil-works/pi-ai'
import type { DbAdapter, SqlValue } from '@justfiles/core'
import { describe, expect, test } from 'vitest'
import type { KvStorage } from './integrations/storage.ts'
import {
	aiLimitsMicros,
	createAiMeter,
	DEFAULT_TIER,
	evaluate,
	readTier,
	setTier,
	TIERS
} from './quota.ts'
import type { AiUsage, StorageUsage, UsageReport } from './usage.ts'

const MB = 1024 * 1024
const GB = 1024 * MB

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

function realDb(): DbAdapter {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		`CREATE TABLE fs_inodes (content_hash TEXT);
		 CREATE TABLE fs_contents (content_hash TEXT, storage_kind INTEGER, size INTEGER);`
	)
	const db: DbAdapter = {
		async query<T extends Record<string, unknown>>(sql: string, args: SqlValue[] = []) {
			return sqlite
				.prepare(sql)
				.all(...(args as (string | number | bigint | null)[])) as unknown as T[]
		},
		async run(sql: string, args: SqlValue[] = []) {
			sqlite.prepare(sql).run(...(args as (string | number | bigint | null)[]))
		},
		async transaction(fn) {
			await fn(db)
		}
	}
	return db
}

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

function ai(burstUsd: number, weeklyUsd: number): AiUsage {
	return {
		burst: { costUsd: burstUsd, resetsAt: 1000 },
		weekly: { costUsd: weeklyUsd, resetsAt: 2000 },
		totalTokens: 0,
		requests: 0,
		lifetimeCostUsd: weeklyUsd,
		lifetimeRequests: 0
	}
}

function storage(logicalBytes: number): StorageUsage {
	return { logicalBytes, blobCount: 0, inlineBytes: 0, r2Bytes: 0, physicalBytes: 0 }
}

function report(burstUsd: number, weeklyUsd: number, logicalBytes: number): UsageReport {
	return { ai: ai(burstUsd, weeklyUsd), storage: storage(logicalBytes) }
}

describe('evaluate', () => {
	test('reports headroom under the free caps and carries reset instants', () => {
		const q = evaluate(report(0.1, 0.4, 100 * MB), 'free')
		expect(q.tier).toBe('free')
		expect(q.aiBurst.exceeded).toBe(false)
		expect(q.aiWeekly.exceeded).toBe(false)
		expect(q.aiBurst.remaining).toBeCloseTo((TIERS.free.aiBurstUsd ?? 0) - 0.1)
		expect(q.aiWeekly.fraction).toBeCloseTo(0.4 / (TIERS.free.aiWeeklyUsd ?? 0))
		expect(q.aiBurst.resetsAt).toBe(1000)
		expect(q.aiWeekly.resetsAt).toBe(2000)
		expect(q.storage.exceeded).toBe(false)
	})

	test('flags exceeded and clamps remaining to zero at/over a cap', () => {
		const q = evaluate(
			report(
				TIERS.free.aiBurstUsd ?? 0,
				TIERS.free.aiWeeklyUsd ?? 0,
				(TIERS.free.storageBytes ?? 0) + 1
			),
			'free'
		)
		expect(q.aiBurst.exceeded).toBe(true)
		expect(q.aiBurst.remaining).toBe(0)
		expect(q.aiWeekly.exceeded).toBe(true)
		expect(q.aiWeekly.remaining).toBe(0)
		expect(q.storage.exceeded).toBe(true)
		expect(q.storage.remaining).toBe(0)
	})

	test('the pro tier grants more headroom than free for the same usage', () => {
		// burst 1 and weekly 4 clear the free caps but sit under pro's; 5 GB is over free, under pro.
		const usage = report(1, 4, 5 * GB)
		expect(evaluate(usage, 'free').aiBurst.exceeded).toBe(true)
		expect(evaluate(usage, 'free').aiWeekly.exceeded).toBe(true)
		expect(evaluate(usage, 'pro').aiBurst.exceeded).toBe(false)
		expect(evaluate(usage, 'pro').aiWeekly.exceeded).toBe(false)
		expect(evaluate(usage, 'pro').storage.exceeded).toBe(false)
	})

	test('unlimited caps never gate', () => {
		const q = evaluate(report(999, 999, 999 * GB), 'unlimited')
		expect(q.aiBurst.exceeded).toBe(false)
		expect(q.aiWeekly.exceeded).toBe(false)
		expect(q.storage.exceeded).toBe(false)
		expect(q.aiBurst.remaining).toBeNull()
	})
})

describe('aiLimitsMicros', () => {
	test('converts each tier cap to micro-USD for the gate', () => {
		expect(aiLimitsMicros('free')).toEqual({
			burst: Math.round((TIERS.free.aiBurstUsd ?? 0) * 1_000_000),
			weekly: Math.round((TIERS.free.aiWeeklyUsd ?? 0) * 1_000_000)
		})
		expect(aiLimitsMicros('unlimited')).toEqual({ burst: null, weekly: null })
	})
})

describe('tier storage', () => {
	test('defaults to free and round-trips through setTier', async () => {
		const kv = memKv()
		expect(await readTier(kv)).toBe(DEFAULT_TIER)
		await setTier(kv, 'pro')
		expect(await readTier(kv)).toBe('pro')
	})

	test('falls back to free for an unknown stored value', async () => {
		const kv = memKv()
		await kv.put('usage/tier', 'enterprise')
		expect(await readTier(kv)).toBe('free')
	})
})

describe('createAiMeter schema readiness', () => {
	test('construction does no schema work and concurrent cold calls initialise once', async () => {
		const db = realDb()
		const run = db.run.bind(db)
		let creates = 0
		let release!: () => void
		const blocked = new Promise<void>((resolve) => {
			release = resolve
		})
		db.run = async (sql, args) => {
			if (sql.includes('CREATE TABLE IF NOT EXISTS usage_ai')) {
				creates++
				await blocked
			}
			await run(sql, args)
		}

		const meter = createAiMeter(db, memKv())
		expect(creates).toBe(0)

		const calls = [meter.admitOrThrow(), meter.admitOrThrow(), meter.admitOrThrow()]
		expect(creates).toBe(1)
		release()
		await Promise.all(calls)
		expect(creates).toBe(1)
	})

	test('readUsage initialises a cold meter', async () => {
		const meter = createAiMeter(realDb(), memKv())

		const report = await meter.readUsage(4096)

		expect(report.ai).toMatchObject({
			burst: { costUsd: 0, resetsAt: null },
			weekly: { costUsd: 0 },
			totalTokens: 0,
			requests: 0,
			lifetimeCostUsd: 0,
			lifetimeRequests: 0
		})
		expect(report.storage.physicalBytes).toBe(4096)
	})

	test('record initialises a cold meter', async () => {
		const meter = createAiMeter(realDb(), memKv())
		await meter.record({ burstExpires: 0, weeklyKey: 0 }, EMPTY_USAGE)

		expect((await meter.readUsage(0)).ai.lifetimeRequests).toBe(1)
	})

	test('failed initialisation is evicted so the next call retries', async () => {
		const db = realDb()
		const run = db.run.bind(db)
		let creates = 0
		db.run = async (sql, args) => {
			if (sql.includes('CREATE TABLE IF NOT EXISTS usage_ai') && ++creates === 1) {
				throw new Error('schema unavailable')
			}
			await run(sql, args)
		}
		const meter = createAiMeter(db, memKv())

		await expect(meter.readUsage(0)).rejects.toThrow('schema unavailable')
		await expect(meter.readUsage(0)).resolves.toBeDefined()
		expect(creates).toBe(2)
	})
})
