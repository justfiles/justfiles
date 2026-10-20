import { describe, expect, it } from 'vitest'
import { nextLocalHour } from './timezone.ts'

const at = (iso: string) => Date.parse(iso)

describe('nextLocalHour', () => {
	it('gives the next 04:00 local, today or tomorrow', () => {
		expect(nextLocalHour(at('2026-10-20T03:00:00Z'), 4, 'UTC')).toBe(at('2026-10-20T04:00:00Z'))
		expect(nextLocalHour(at('2026-10-20T04:00:00Z'), 4, 'UTC')).toBe(at('2026-10-21T04:00:00Z'))
		// 2026-10-20 10:00 in Auckland (+13:00): the next 04:00 there is the 21st.
		expect(nextLocalHour(at('2026-10-19T21:00:00Z'), 4, 'Pacific/Auckland')).toBe(
			at('2026-10-20T15:00:00Z')
		)
	})

	it('keeps 04:00 local on the days the clocks change', () => {
		// New York springs forward at 02:00 on 2027-03-14 (EST to EDT) and falls back at 02:00
		// on 2026-11-01 (EDT to EST).
		expect(nextLocalHour(at('2027-03-14T05:00:00Z'), 4, 'America/New_York')).toBe(
			at('2027-03-14T08:00:00Z')
		)
		expect(nextLocalHour(at('2026-11-01T05:00:00Z'), 4, 'America/New_York')).toBe(
			at('2026-11-01T09:00:00Z')
		)
	})
})
