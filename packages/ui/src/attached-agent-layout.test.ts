import { describe, expect, test } from 'vitest'
import { effectiveMode } from './attached-agent-layout.ts'

describe('effectiveMode', () => {
	test('keeps sheet mode at every width', () => {
		expect(effectiveMode('sheet', 400, 280)).toBe('sheet')
	})

	test('keeps a sidebar when the app retains its minimum width', () => {
		expect(effectiveMode('sidebar', 601, 280)).toBe('sidebar')
	})

	test('falls back to a sheet without changing the preference', () => {
		expect(effectiveMode('sidebar', 600, 280)).toBe('sheet')
	})

	test('applies the sidebar minimum to small saved sizes', () => {
		expect(effectiveMode('sidebar', 560, 100)).toBe('sheet')
	})
})
