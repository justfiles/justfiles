import type { Usage } from '@earendil-works/pi-ai'
import type { DbAdapter } from '@justfiles/core'
import { describe, expect, test } from 'vitest'
import type { KvStorage } from './integrations/storage.ts'
import { type AiUsage, accrueAi, readUsage } from './usage.ts'

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
})
