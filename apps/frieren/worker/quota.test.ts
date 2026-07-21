import { describe, expect, test } from 'vitest'
import type { KvStorage } from './integrations/storage.ts'
import { aiLimitMicros, DEFAULT_TIER, evaluate, readTier, setTier, TIERS } from './quota.ts'
import type { AiUsage, StorageUsage, UsageReport } from './usage.ts'

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

function ai(costUsd: number): AiUsage {
	return {
		window: '2025-01',
		costUsd,
		totalTokens: 0,
		requests: 0,
		lifetimeCostUsd: costUsd,
		lifetimeRequests: 0
	}
}

function storage(logicalBytes: number): StorageUsage {
	return { logicalBytes, blobCount: 0, inlineBytes: 0, r2Bytes: 0, physicalBytes: 0 }
}

function report(costUsd: number, logicalBytes: number): UsageReport {
	return { ai: ai(costUsd), storage: storage(logicalBytes) }
}

describe('evaluate', () => {
	test('reports headroom under the free cap', () => {
		const q = evaluate(report(0.4, 100 * 1024 * 1024), 'free')
		expect(q.tier).toBe('free')
		expect(q.ai.exceeded).toBe(false)
		expect(q.ai.remaining).toBeCloseTo((TIERS.free.aiCostUsd ?? 0) - 0.4)
		expect(q.ai.fraction).toBeCloseTo(0.4 / (TIERS.free.aiCostUsd ?? 0))
		expect(q.storage.exceeded).toBe(false)
	})

	test('flags exceeded and clamps remaining to zero at/over the cap', () => {
		const q = evaluate(
			report(TIERS.free.aiCostUsd ?? 0, (TIERS.free.storageBytes ?? 0) + 1),
			'free'
		)
		expect(q.ai.exceeded).toBe(true)
		expect(q.ai.remaining).toBe(0)
		expect(q.storage.exceeded).toBe(true)
		expect(q.storage.remaining).toBe(0)
	})

	test('the pro tier grants more headroom than free for the same usage', () => {
		const usage = report(5, 5 * 1024 * 1024 * 1024)
		expect(evaluate(usage, 'free').ai.exceeded).toBe(true)
		expect(evaluate(usage, 'pro').ai.exceeded).toBe(false)
		expect(evaluate(usage, 'pro').storage.exceeded).toBe(false)
	})
})

describe('aiLimitMicros', () => {
	test('converts the tier cap to micro-USD for the reserve gate', () => {
		expect(aiLimitMicros('free')).toBe(Math.round((TIERS.free.aiCostUsd ?? 0) * 1_000_000))
		expect(aiLimitMicros('pro')).toBe(Math.round((TIERS.pro.aiCostUsd ?? 0) * 1_000_000))
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
