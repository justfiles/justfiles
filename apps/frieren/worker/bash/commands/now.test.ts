import { describe, expect, test } from 'bun:test'
import type { Volume } from '@justfiles/fs'
import { createNowCommand } from './now.ts'

const ctx = { vol: undefined as unknown as Volume }

describe('now command', () => {
	test('prints ISO time with offset for resolved tz', async () => {
		const cmd = createNowCommand({ getTimezone: () => 'America/New_York' })
		const res = await cmd.run([], ctx)
		expect(res.exitCode).toBe(0)
		expect(res.stdout).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2} \(America\/New_York\)$/
		)
	})

	test('positional tz arg overrides resolver', async () => {
		const cmd = createNowCommand({ getTimezone: () => 'America/New_York' })
		const res = await cmd.run(['Asia/Tokyo'], ctx)
		expect(res.exitCode).toBe(0)
		expect(res.stdout).toMatch(/\+09:00 \(Asia\/Tokyo\)$/)
	})

	test('falls back to UTC when no resolver and no arg', async () => {
		const cmd = createNowCommand()
		const res = await cmd.run([], ctx)
		expect(res.exitCode).toBe(0)
		expect(res.stdout).toMatch(/Z \(UTC\)$/)
	})
})
