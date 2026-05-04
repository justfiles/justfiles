import { describe, expect, test } from 'bun:test'
import { formatInTimezone, isoToTimezone } from './timezone'

describe('formatInTimezone', () => {
	test('renders UTC instant in America/New_York with -04:00 offset', () => {
		const at = new Date('2026-05-10T10:00:00Z')
		expect(formatInTimezone(at, 'America/New_York')).toBe('2026-05-10T06:00:00-04:00')
	})

	test('renders UTC instant in Asia/Tokyo with +09:00 offset', () => {
		const at = new Date('2026-05-10T00:00:00Z')
		expect(formatInTimezone(at, 'Asia/Tokyo')).toBe('2026-05-10T09:00:00+09:00')
	})

	test('renders UTC tz with Z suffix', () => {
		const at = new Date('2026-05-10T12:34:56Z')
		expect(formatInTimezone(at, 'UTC')).toBe('2026-05-10T12:34:56Z')
	})

	test('falls back to ISO Z on invalid timezone', () => {
		const at = new Date('2026-05-10T12:34:56Z')
		expect(formatInTimezone(at, 'Not/A_Real_Zone')).toBe('2026-05-10T12:34:56Z')
	})
})

describe('isoToTimezone', () => {
	test('passes through date-only strings unchanged', () => {
		expect(isoToTimezone('2026-05-10', 'America/New_York')).toBe('2026-05-10')
	})

	test('converts ISO datetime to user timezone', () => {
		expect(isoToTimezone('2026-05-10T10:00:00Z', 'America/New_York')).toBe(
			'2026-05-10T06:00:00-04:00'
		)
	})
})
