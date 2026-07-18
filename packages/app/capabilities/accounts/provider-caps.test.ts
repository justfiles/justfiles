import { describe, expect, test } from 'vitest'
import type { Connection } from './connection.ts'
import { backs, CALENDAR_SCOPE, capabilitiesOf, GMAIL_SCOPE, scopeFor } from './provider-caps.ts'

const conn = (over: Partial<Connection> = {}): Connection => ({
	id: 'c',
	kind: 'google',
	creds: {},
	...over
})

describe('provider-caps', () => {
	test('scopeFor maps oauth capabilities to scopes; form/ai have none', () => {
		expect(scopeFor('google', 'email')).toBe(GMAIL_SCOPE)
		expect(scopeFor('google', 'calendar')).toBe(CALENDAR_SCOPE)
		expect(scopeFor('icloud', 'calendar')).toBeUndefined()
		expect(scopeFor('chatgpt', 'ai')).toBeUndefined()
	})

	test('backs derives scope-gated capabilities from granted scopes', () => {
		expect(backs(conn({ scopes: [GMAIL_SCOPE] }), 'email')).toBe(true)
		expect(backs(conn({ scopes: [GMAIL_SCOPE] }), 'calendar')).toBe(false)
		expect(backs(conn({ scopes: [GMAIL_SCOPE, CALENDAR_SCOPE] }), 'calendar')).toBe(true)
		expect(backs(conn({ scopes: [] }), 'email')).toBe(false)
	})

	test('backs is true for scope-less capabilities when the kind declares them', () => {
		expect(backs(conn({ kind: 'icloud' }), 'calendar')).toBe(true)
		expect(backs(conn({ kind: 'chatgpt' }), 'ai')).toBe(true)
		expect(backs(conn({ kind: 'icloud' }), 'email')).toBe(false)
	})

	test('capabilitiesOf lists what a kind can back', () => {
		expect(capabilitiesOf('google').sort()).toEqual(['calendar', 'email'])
		expect(capabilitiesOf('chatgpt')).toEqual(['ai'])
		expect(capabilitiesOf('unknown')).toEqual([])
	})
})
