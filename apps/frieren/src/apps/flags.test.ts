import { afterEach, describe, expect, test, vi } from 'vitest'
import { shouldUseLocalKernel } from './flags.ts'

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('shouldUseLocalKernel', () => {
	test('off when the flag is unset or empty', () => {
		expect(shouldUseLocalKernel('app.frieren.paint')).toBe(false)
		vi.stubEnv('VITE_FRIEREN_LOCAL_APPS', '')
		expect(shouldUseLocalKernel('app.frieren.paint')).toBe(false)
	})

	test('"1" / "true" enable every app', () => {
		vi.stubEnv('VITE_FRIEREN_LOCAL_APPS', '1')
		expect(shouldUseLocalKernel('anything')).toBe(true)
		vi.stubEnv('VITE_FRIEREN_LOCAL_APPS', 'true')
		expect(shouldUseLocalKernel('anything')).toBe(true)
	})

	test('a csv list enables only the listed apps (whitespace-tolerant)', () => {
		vi.stubEnv('VITE_FRIEREN_LOCAL_APPS', 'app.frieren.paint, app.frieren.notes')
		expect(shouldUseLocalKernel('app.frieren.paint')).toBe(true)
		expect(shouldUseLocalKernel('app.frieren.notes')).toBe(true)
		expect(shouldUseLocalKernel('app.frieren.finder')).toBe(false)
	})
})
