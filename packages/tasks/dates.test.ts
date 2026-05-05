import { describe, expect, test } from 'bun:test'
import {
	isOverdue,
	isValidTimezone,
	nowTimestamp,
	resolveTimezone,
	systemTimezone,
	today
} from './dates.ts'

describe('dates', () => {
	test('resolveTimezone follows precedence flag > env > option > default', () => {
		expect(
			resolveTimezone({
				flag: 'Pacific/Auckland',
				env: 'Australia/Sydney',
				option: 'America/Los_Angeles'
			})
		).toBe('Pacific/Auckland')
		expect(resolveTimezone({ env: 'Australia/Sydney', option: 'America/Los_Angeles' })).toBe(
			'Australia/Sydney'
		)
		expect(resolveTimezone({ option: 'America/Los_Angeles' })).toBe('America/Los_Angeles')
		expect(resolveTimezone()).toBe(systemTimezone())
	})

	test('resolveTimezone treats empty strings as absent', () => {
		expect(resolveTimezone({ flag: '', env: 'Asia/Tokyo' })).toBe('Asia/Tokyo')
	})

	test('today formats YYYYMMDD in the configured timezone', () => {
		// 2026-06-15 23:30 UTC → next day in Auckland (UTC+12)
		const t = new Date('2026-06-15T23:30:00Z')
		expect(today('Pacific/Auckland', t)).toBe('20260616')
		expect(today('UTC', t)).toBe('20260615')
		expect(today('America/Los_Angeles', t)).toBe('20260615')
	})

	test('today midnight boundary is timezone-local', () => {
		// 2026-01-01 00:30 UTC → still Dec 31 in LA (UTC-8)
		const t = new Date('2026-01-01T00:30:00Z')
		expect(today('UTC', t)).toBe('20260101')
		expect(today('America/Los_Angeles', t)).toBe('20251231')
	})

	test('nowTimestamp formats YYYYMMDDTHHMMSS in the configured timezone', () => {
		const t = new Date('2026-05-05T10:15:30Z')
		expect(nowTimestamp('UTC', t)).toBe('20260505T101530')
		// Sydney is UTC+10 in May (no DST)
		expect(nowTimestamp('Australia/Sydney', t)).toBe('20260505T201530')
	})

	test('isOverdue is true only for TODO with past due', () => {
		const now = new Date('2026-06-15T12:00:00Z')
		expect(isOverdue('20260614', 'TODO', 'UTC', now)).toBe(true)
		expect(isOverdue('20260615', 'TODO', 'UTC', now)).toBe(false)
		expect(isOverdue('20260616', 'TODO', 'UTC', now)).toBe(false)
		expect(isOverdue('20260614', 'DONE', 'UTC', now)).toBe(false)
		expect(isOverdue(undefined, 'TODO', 'UTC', now)).toBe(false)
	})

	test('isValidTimezone accepts IANA names and rejects nonsense', () => {
		expect(isValidTimezone('Pacific/Auckland')).toBe(true)
		expect(isValidTimezone('UTC')).toBe(true)
		expect(isValidTimezone('Not/A/Zone')).toBe(false)
	})
})
