import { describe, expect, test } from 'bun:test'
import {
	isOverdue,
	isValidTimezone,
	nowTimestamp,
	parseDueInput,
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

describe('parseDueInput', () => {
	// Monday 2026-06-15
	const monday = new Date('2026-06-15T12:00:00Z')

	test('ISO YYYYMMDD passes through', () => {
		expect(parseDueInput('20260615', 'UTC', monday)).toBe('20260615')
		expect(parseDueInput('20261231', 'UTC', monday)).toBe('20261231')
	})

	test('today, tomorrow, yesterday', () => {
		expect(parseDueInput('today', 'UTC', monday)).toBe('20260615')
		expect(parseDueInput('tomorrow', 'UTC', monday)).toBe('20260616')
		expect(parseDueInput('yesterday', 'UTC', monday)).toBe('20260614')
	})

	test('next week, next month, next year', () => {
		expect(parseDueInput('next week', 'UTC', monday)).toBe('20260622')
		expect(parseDueInput('next month', 'UTC', monday)).toBe('20260715')
		expect(parseDueInput('next year', 'UTC', monday)).toBe('20270615')
	})

	test('weekday short names resolve to next occurrence including today', () => {
		// monday = Mon → today
		expect(parseDueInput('mon', 'UTC', monday)).toBe('20260615')
		// tuesday → next day
		expect(parseDueInput('tue', 'UTC', monday)).toBe('20260616')
		// sunday → 6 days forward
		expect(parseDueInput('sun', 'UTC', monday)).toBe('20260621')
	})

	test('weekday full names resolve correctly', () => {
		expect(parseDueInput('monday', 'UTC', monday)).toBe('20260615')
		expect(parseDueInput('friday', 'UTC', monday)).toBe('20260619')
		expect(parseDueInput('saturday', 'UTC', monday)).toBe('20260620')
	})

	test('+N relative offsets', () => {
		expect(parseDueInput('+3d', 'UTC', monday)).toBe('20260618')
		expect(parseDueInput('+2w', 'UTC', monday)).toBe('20260629')
		expect(parseDueInput('+1m', 'UTC', monday)).toBe('20260715')
		expect(parseDueInput('+1y', 'UTC', monday)).toBe('20270615')
	})

	test('parsing is case-insensitive and trims whitespace', () => {
		expect(parseDueInput('  Tomorrow  ', 'UTC', monday)).toBe('20260616')
		expect(parseDueInput('MON', 'UTC', monday)).toBe('20260615')
		expect(parseDueInput('Next Week', 'UTC', monday)).toBe('20260622')
	})

	test('invalid input throws with a helpful message', () => {
		expect(() => parseDueInput('next', 'UTC', monday)).toThrow('invalid date')
		expect(() => parseDueInput('friday the 13th', 'UTC', monday)).toThrow('invalid date')
		expect(() => parseDueInput('20261332', 'UTC', monday)).not.toThrow() // passthrough, not validated further
	})

	test('timezone-aware: today uses configured timezone', () => {
		// 2026-06-15 23:30 UTC → June 16 in Auckland (UTC+12)
		const t = new Date('2026-06-15T23:30:00Z')
		expect(parseDueInput('today', 'Pacific/Auckland', t)).toBe('20260616')
		expect(parseDueInput('today', 'UTC', t)).toBe('20260615')
	})

	test('year boundary: +1y from Dec 31', () => {
		const dec31 = new Date('2026-12-31T12:00:00Z')
		expect(parseDueInput('+1y', 'UTC', dec31)).toBe('20271231')
	})

	test('month boundary: +30d from Jan 15', () => {
		const jan15 = new Date('2026-01-15T12:00:00Z')
		expect(parseDueInput('+30d', 'UTC', jan15)).toBe('20260214')
	})
})
