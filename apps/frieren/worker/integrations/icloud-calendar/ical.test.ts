import { describe, expect, test } from 'bun:test'
import { generateIcs, parseIcs } from './ical.ts'

const UTC_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:abc-123@test
SUMMARY:Team standup
DTSTART:20240115T100000Z
DTEND:20240115T103000Z
DESCRIPTION:Daily sync
LOCATION:Room A
END:VEVENT
END:VCALENDAR`

const ALL_DAY_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:allday-1@test
SUMMARY:Birthday
DTSTART;VALUE=DATE:20240115
DTEND;VALUE=DATE:20240116
END:VEVENT
END:VCALENDAR`

const TZID_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:tzid-1@test
SUMMARY:New York meeting
DTSTART;TZID=America/New_York:20240115T100000
DTEND;TZID=America/New_York:20240115T110000
END:VEVENT
END:VCALENDAR`

// RFC 5545 §3.1: fold by inserting CRLF + single whitespace; unfolding removes both.
// The fold point is after the trailing space in "Long summary that ", so unfolded
// value is "Long summary that continues on next line" (one space, from the content).
const FOLDED_ICS = [
	'BEGIN:VCALENDAR',
	'VERSION:2.0',
	'BEGIN:VEVENT',
	'UID:fold-1@test',
	'SUMMARY:Long summary that ', // trailing space is content; fold indicator is the leading space below
	' continues on next line',
	'DTSTART:20240115T100000Z',
	'DTEND:20240115T110000Z',
	'DESCRIPTION:A long description folded ',
	' mid-line.',
	'END:VEVENT',
	'END:VCALENDAR'
].join('\r\n')

const MULTI_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:ev-1@test
SUMMARY:First
DTSTART:20240115T090000Z
DTEND:20240115T100000Z
END:VEVENT
BEGIN:VEVENT
UID:ev-2@test
SUMMARY:Second
DTSTART:20240116T090000Z
DTEND:20240116T100000Z
END:VEVENT
END:VCALENDAR`

describe('parseIcs', () => {
	test('parses a single VEVENT with UTC timestamps', () => {
		const events = parseIcs(UTC_ICS)
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			uid: 'abc-123@test',
			summary: 'Team standup',
			dtstart: '2024-01-15T10:00:00Z',
			dtend: '2024-01-15T10:30:00Z',
			description: 'Daily sync',
			location: 'Room A'
		})
	})

	test('parses DTSTART with VALUE=DATE (all-day event)', () => {
		const events = parseIcs(ALL_DAY_ICS)
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			uid: 'allday-1@test',
			summary: 'Birthday',
			dtstart: '2024-01-15',
			dtend: '2024-01-16'
		})
	})

	test('normalises DTSTART with TZID to UTC', () => {
		const events = parseIcs(TZID_ICS)
		expect(events).toHaveLength(1)
		// America/New_York is UTC-5 in January (EST)
		expect(events[0]?.dtstart).toBe('2024-01-15T15:00:00Z')
		expect(events[0]?.dtend).toBe('2024-01-15T16:00:00Z')
	})

	test('unfolds folded lines before parsing', () => {
		const events = parseIcs(FOLDED_ICS)
		expect(events).toHaveLength(1)
		expect(events[0]?.summary).toBe('Long summary that continues on next line')
		expect(events[0]?.description).toBe('A long description folded mid-line.')
	})

	test('parses multiple VEVENT blocks', () => {
		const events = parseIcs(MULTI_ICS)
		expect(events).toHaveLength(2)
		expect(events[0]?.uid).toBe('ev-1@test')
		expect(events[1]?.uid).toBe('ev-2@test')
	})

	test('skips incomplete VEVENT blocks', () => {
		const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:No uid or dates
END:VEVENT
END:VCALENDAR`
		expect(parseIcs(ics)).toHaveLength(0)
	})
})

describe('generateIcs', () => {
	test('produces a valid VCALENDAR/VEVENT string', () => {
		const ics = generateIcs({
			uid: 'gen-1@test',
			summary: 'Generated event',
			dtstart: '2024-01-15T10:00:00Z',
			dtend: '2024-01-15T11:00:00Z'
		})
		expect(ics).toContain('BEGIN:VCALENDAR')
		expect(ics).toContain('BEGIN:VEVENT')
		expect(ics).toContain('UID:gen-1@test')
		expect(ics).toContain('SUMMARY:Generated event')
		expect(ics).toContain('DTSTART:20240115T100000Z')
		expect(ics).toContain('DTEND:20240115T110000Z')
		expect(ics).toContain('END:VEVENT')
		expect(ics).toContain('END:VCALENDAR')
	})

	test('uses VALUE=DATE for all-day events', () => {
		const ics = generateIcs({
			uid: 'allday-gen@test',
			summary: 'All day',
			dtstart: '2024-01-15',
			dtend: '2024-01-16'
		})
		expect(ics).toContain('DTSTART;VALUE=DATE:20240115')
		expect(ics).toContain('DTEND;VALUE=DATE:20240116')
	})

	test('includes optional fields when present', () => {
		const ics = generateIcs({
			uid: 'opt@test',
			summary: 'With extras',
			dtstart: '2024-01-15T10:00:00Z',
			dtend: '2024-01-15T11:00:00Z',
			description: 'A description',
			location: 'Office'
		})
		expect(ics).toContain('DESCRIPTION:A description')
		expect(ics).toContain('LOCATION:Office')
	})
})

describe('round-trip', () => {
	test('generate then parse recovers original UTC event fields', () => {
		const original = {
			uid: 'rt-utc@test',
			summary: 'Round trip',
			dtstart: '2024-06-15T14:00:00Z',
			dtend: '2024-06-15T15:30:00Z',
			description: 'Test',
			location: 'Online'
		}
		const ics = generateIcs(original)
		const parsed = parseIcs(ics)
		expect(parsed).toHaveLength(1)
		expect(parsed[0]).toMatchObject(original)
	})

	test('generate then parse recovers original all-day event', () => {
		const original = {
			uid: 'rt-date@test',
			summary: 'All day round trip',
			dtstart: '2024-07-04',
			dtend: '2024-07-05'
		}
		const ics = generateIcs(original)
		const parsed = parseIcs(ics)
		expect(parsed).toHaveLength(1)
		expect(parsed[0]).toMatchObject(original)
	})
})
