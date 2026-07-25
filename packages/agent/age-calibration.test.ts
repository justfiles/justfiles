import { describe, expect, test } from 'vitest'
import { ageCalibration } from './age-calibration.ts'

// A fixed "today" keeps the computed ages deterministic.
const today = new Date('2024-06-15')

describe('ageCalibration', () => {
	test('states an adult man', () => {
		expect(ageCalibration('---\nbirth_date: 1990-01-01\ngender: male\n---\n', today)).toContain(
			'The user is 34 years old, a man.'
		)
	})

	test('states a kid girl with kid-appropriate tone', () => {
		const out = ageCalibration('---\nbirth_date: 2016-01-01\ngender: female\n---\n', today)
		expect(out).toContain('The user is 8 years old, a girl.')
		expect(out).toMatch(/second-grader/)
	})

	test('omits the gender noun for non-binary / self-described / unset', () => {
		expect(
			ageCalibration('---\nbirth_date: 1990-01-01\ngender: nonbinary\n---\n', today)
		).toContain('The user is 34 years old.')
		expect(ageCalibration('---\nbirth_date: 1990-01-01\n---\n', today)).toContain(
			'The user is 34 years old.'
		)
	})

	test('accepts the looser `birthday` key', () => {
		expect(ageCalibration('---\nbirthday: 1990-01-01\n---\n', today)).toContain('The user is 34')
	})

	test('omits the gender noun when asked (purpose-scoped learning projection)', () => {
		const out = ageCalibration('---\nbirth_date: 2016-01-01\ngender: female\n---\n', today, {
			gender: false
		})
		expect(out).toContain('The user is 8 years old.')
		expect(out).not.toMatch(/\b(girl|boy|man|woman)\b/)
		expect(out).toMatch(/second-grader/)
	})

	test('returns null without a birth date', () => {
		expect(ageCalibration('---\nname: Ada\n---\n', today)).toBeNull()
	})
})
