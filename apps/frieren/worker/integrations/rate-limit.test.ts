import { describe, expect, test } from 'vitest'
import { TokenBucket } from './rate-limit.ts'

describe('TokenBucket', () => {
	test('allows up to capacity within the window', () => {
		const bucket = new TokenBucket({ capacity: 3, windowMs: 60_000, now: () => 1000 })
		expect(bucket.take('k')).toBe(true)
		expect(bucket.take('k')).toBe(true)
		expect(bucket.take('k')).toBe(true)
		expect(bucket.take('k')).toBe(false)
	})

	test('refills after the window has elapsed', () => {
		let now = 1000
		const bucket = new TokenBucket({ capacity: 2, windowMs: 60_000, now: () => now })
		expect(bucket.take('k')).toBe(true)
		expect(bucket.take('k')).toBe(true)
		expect(bucket.take('k')).toBe(false)
		now += 60_001
		expect(bucket.take('k')).toBe(true)
	})

	test('keys are independent', () => {
		const bucket = new TokenBucket({ capacity: 1, windowMs: 60_000, now: () => 1 })
		expect(bucket.take('a')).toBe(true)
		expect(bucket.take('a')).toBe(false)
		expect(bucket.take('b')).toBe(true)
	})
})
