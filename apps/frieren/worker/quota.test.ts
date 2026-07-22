import { describe, expect, test } from 'vitest'
import type { KvStorage } from './integrations/storage.ts'
import { aiLimitsMicros, DEFAULT_TIER, evaluate, readTier, setTier, TIERS } from './quota.ts'
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
	test('converts each tier cap to micro-USD for the reserve gate', () => {
		expect(aiLimitsMicros('free')).toEqual({
			burst: Math.round((TIERS.free.aiBurstUsd ?? 0) * 1_000_000),
			weekly: Math.round((TIERS.free.aiWeeklyUsd ?? 0) * 1_000_000)
		})
		expect(aiLimitsMicros('unlimited')).toEqual({ burst: null, weekly: null })
	})

	test('the free burst cap exceeds a single call reservation, so calls can be admitted', () => {
		// callReserveMicros for gpt-5.4-mini is ~$0.066 (40k input × 0.75 + 8k output × 4.5).
		// The burst cap must stay above it or every call is rejected.
		expect(aiLimitsMicros('free').burst).toBeGreaterThan(70_000)
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
