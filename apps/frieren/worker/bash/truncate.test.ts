import { describe, expect, test } from 'vitest'
import { MAX_OUTPUT_BYTES, truncateTail } from './truncate.ts'

const enc = new TextEncoder()

describe('truncateTail', () => {
	test('returns input unchanged when under the cap', () => {
		const r = truncateTail('hello\nworld')
		expect(r.text).toBe('hello\nworld')
		expect(r.truncated).toBe(false)
		expect(r.droppedBytes).toBe(0)
	})

	test('keeps the tail when over the cap', () => {
		const big = 'x'.repeat(MAX_OUTPUT_BYTES + 1000)
		const r = truncateTail(big)
		expect(r.truncated).toBe(true)
		expect(r.droppedBytes).toBeGreaterThan(0)
		expect(r.text.startsWith('[truncated:')).toBe(true)
		expect(r.text.endsWith('x'.repeat(8))).toBe(true)
		expect(enc.encode(r.text).byteLength).toBeLessThanOrEqual(MAX_OUTPUT_BYTES + 64)
	})

	test('respects custom maxBytes', () => {
		const r = truncateTail('abcdefghij', { maxBytes: 4 })
		expect(r.truncated).toBe(true)
		expect(r.droppedBytes).toBe(6)
		expect(r.text).toBe('[truncated: 6 bytes dropped]\nghij')
	})

	test('counts dropped bytes against the original input', () => {
		const big = 'a'.repeat(100)
		const r = truncateTail(big, { maxBytes: 10 })
		expect(r.droppedBytes).toBe(90)
	})
})
