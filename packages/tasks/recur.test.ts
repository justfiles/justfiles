import { describe, expect, test } from 'bun:test'
import { addInterval, isValidInterval, nextDue } from './recur.ts'

describe('isValidInterval', () => {
	test('accepts aliases', () => {
		for (const a of ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']) {
			expect(isValidInterval(a)).toBe(true)
		}
	})

	test('accepts numeric forms', () => {
		expect(isValidInterval('1d')).toBe(true)
		expect(isValidInterval('3d')).toBe(true)
		expect(isValidInterval('2w')).toBe(true)
		expect(isValidInterval('6m')).toBe(true)
		expect(isValidInterval('1y')).toBe(true)
		expect(isValidInterval('100d')).toBe(true)
	})

	test('accepts weekdays', () => {
		for (const d of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
			expect(isValidInterval(d)).toBe(true)
		}
	})

	test('rejects invalid', () => {
		expect(isValidInterval('')).toBe(false)
		expect(isValidInterval('0d')).toBe(false)
		expect(isValidInterval('d')).toBe(false)
		expect(isValidInterval('monday')).toBe(false)
		expect(isValidInterval('daily2')).toBe(false)
		expect(isValidInterval('x')).toBe(false)
	})
})

describe('addInterval', () => {
	// 2026-05-04 is a Monday
	test('daily adds 1 day', () => {
		expect(addInterval('20260505', 'daily')).toBe('20260506')
	})

	test('weekly adds 7 days', () => {
		expect(addInterval('20260505', 'weekly')).toBe('20260512')
	})

	test('biweekly adds 14 days', () => {
		expect(addInterval('20260505', 'biweekly')).toBe('20260519')
	})

	test('monthly adds 1 month', () => {
		expect(addInterval('20260505', 'monthly')).toBe('20260605')
	})

	test('quarterly adds 3 months', () => {
		expect(addInterval('20260505', 'quarterly')).toBe('20260805')
	})

	test('yearly adds 1 year', () => {
		expect(addInterval('20260505', 'yearly')).toBe('20270505')
	})

	test('end-of-month: Jan 31 + monthly = Feb 28 (non-leap)', () => {
		expect(addInterval('20260131', 'monthly')).toBe('20260228')
	})

	test('end-of-month: Jan 31 + monthly = Feb 29 (leap year)', () => {
		expect(addInterval('20240131', 'monthly')).toBe('20240229')
	})

	test('year boundary: Dec 31 + daily = Jan 1', () => {
		expect(addInterval('20261231', 'daily')).toBe('20270101')
	})

	test('year boundary: Dec + yearly', () => {
		expect(addInterval('20261205', 'yearly')).toBe('20271205')
	})

	test('numeric 3d adds 3 days', () => {
		expect(addInterval('20260505', '3d')).toBe('20260508')
	})

	test('numeric 2w adds 14 days', () => {
		expect(addInterval('20260505', '2w')).toBe('20260519')
	})

	test('numeric 6m adds 6 months', () => {
		expect(addInterval('20260505', '6m')).toBe('20261105')
	})

	test('numeric 1y adds 1 year', () => {
		expect(addInterval('20260505', '1y')).toBe('20270505')
	})

	// 2026-05-04 = Monday, 2026-05-05 = Tuesday, 2026-05-08 = Friday, 2026-05-11 = Monday
	test('weekday: next monday after monday is +7', () => {
		expect(addInterval('20260504', 'mon')).toBe('20260511')
	})

	test('weekday: next tuesday after monday is +1', () => {
		expect(addInterval('20260504', 'tue')).toBe('20260505')
	})

	test('weekday: next friday after monday is +4', () => {
		expect(addInterval('20260504', 'fri')).toBe('20260508')
	})

	test('weekday: next sun after saturday is +1', () => {
		// 2026-05-09 = Saturday
		expect(addInterval('20260509', 'sun')).toBe('20260510')
	})

	test('throws on invalid interval', () => {
		expect(() => addInterval('20260505', 'invalid')).toThrow('invalid recurrence interval')
	})
})

describe('nextDue — catch-up', () => {
	test('weekly: original due in past advances past completedAt', () => {
		// due=20260427(Mon), completed=20260504(Mon) → next Mon after 20260504 = 20260511
		expect(nextDue('20260427', { type: 'catchup', interval: 'weekly' }, '20260504')).toBe(
			'20260511'
		)
	})

	test('multiple missed cycles: monthly, many months in past', () => {
		// due=20260101, monthly, completed=20260504
		// 01→02→03→04→05→06; first > 20260504 is 20260601
		expect(nextDue('20260101', { type: 'catchup', interval: 'monthly' }, '20260504')).toBe(
			'20260601'
		)
	})

	test('daily: due yesterday, completed today', () => {
		expect(nextDue('20260504', { type: 'catchup', interval: 'daily' }, '20260504')).toBe('20260505')
	})

	test('no due date: uses completedAt as base, advances by one interval', () => {
		expect(nextDue(undefined, { type: 'catchup', interval: 'weekly' }, '20260504')).toBe('20260511')
	})

	test('weekday catch-up: advances by 7d each step until after completedAt', () => {
		// due=20260428(Tue), completed=20260505(Tue) → 20260428+7=20260505 ≤ 20260505 → +7 → 20260512
		expect(nextDue('20260428', { type: 'catchup', interval: 'tue' }, '20260505')).toBe('20260512')
	})

	test('weekday catch-up with no due: next weekday after completedAt', () => {
		// completed=20260504(Mon), next fri = 20260508
		expect(nextDue(undefined, { type: 'catchup', interval: 'fri' }, '20260504')).toBe('20260508')
	})

	test('3d catch-up: multiple missed cycles', () => {
		// due=20260501, completed=20260510 → 01+3=04, +3=07, +3=10, +3=13 > 10 → 20260513
		expect(nextDue('20260501', { type: 'catchup', interval: '3d' }, '20260510')).toBe('20260513')
	})

	test('end-of-month boundary: Jan 31 monthly catch-up', () => {
		// due=20260131, completed=20260228
		// 20260131 + 1m = 20260228 ≤ 20260228 → + 1m = 20260328
		expect(nextDue('20260131', { type: 'catchup', interval: 'monthly' }, '20260228')).toBe(
			'20260328'
		)
	})
})

describe('nextDue — restart', () => {
	test('weekly: completion date + 7', () => {
		expect(nextDue('20260427', { type: 'restart', interval: 'weekly' }, '20260504')).toBe(
			'20260511'
		)
	})

	test('3d: completion date + 3', () => {
		expect(nextDue('20260401', { type: 'restart', interval: '3d' }, '20260504')).toBe('20260507')
	})

	test('monthly: completion date + 1 month', () => {
		expect(nextDue(undefined, { type: 'restart', interval: 'monthly' }, '20260504')).toBe(
			'20260604'
		)
	})

	test('weekday: next occurrence of that weekday after completion', () => {
		// completed=20260504(Mon), next fri = 20260508
		expect(nextDue('20260401', { type: 'restart', interval: 'fri' }, '20260504')).toBe('20260508')
	})

	test('yearly restart', () => {
		expect(nextDue('20250101', { type: 'restart', interval: 'yearly' }, '20260504')).toBe(
			'20270504'
		)
	})
})

describe('nextDue — fixed', () => {
	test('monthly: original due + 1 month (may be in past)', () => {
		// due=20260401, completed=20260504 → 20260401 + 1m = 20260501 (past, returned anyway)
		expect(nextDue('20260401', { type: 'fixed', interval: 'monthly' }, '20260504')).toBe('20260501')
	})

	test('weekly: original due + 7', () => {
		// due=20260427(Mon), completed=20260504 → 20260427 + 7 = 20260504
		expect(nextDue('20260427', { type: 'fixed', interval: 'weekly' }, '20260504')).toBe('20260504')
	})

	test('fixed may remain in past', () => {
		// due=20260101, monthly, completed=20260504 → 20260201 (well in the past)
		expect(nextDue('20260101', { type: 'fixed', interval: 'monthly' }, '20260504')).toBe('20260201')
	})

	test('no due date: completedAt + interval', () => {
		expect(nextDue(undefined, { type: 'fixed', interval: 'weekly' }, '20260504')).toBe('20260511')
	})

	test('end-of-month: Jan 31 monthly → Feb 28', () => {
		expect(nextDue('20260131', { type: 'fixed', interval: 'monthly' }, '20260131')).toBe('20260228')
	})

	test('year boundary', () => {
		expect(nextDue('20261201', { type: 'fixed', interval: 'yearly' }, '20261201')).toBe('20271201')
	})

	test('biweekly fixed', () => {
		expect(nextDue('20260420', { type: 'fixed', interval: 'biweekly' }, '20260420')).toBe(
			'20260504'
		)
	})
})

describe('nextDue — DST boundary dates', () => {
	// Pure YYYYMMDD arithmetic uses UTC internally; DST has no effect.
	test('spring forward (US): 2026-03-08 + weekly = 2026-03-15', () => {
		expect(nextDue('20260308', { type: 'restart', interval: 'weekly' }, '20260308')).toBe(
			'20260315'
		)
	})

	test('fall back (US): catch-up crosses 2026-11-01', () => {
		expect(nextDue('20261025', { type: 'catchup', interval: 'weekly' }, '20261025')).toBe(
			'20261101'
		)
	})
})
