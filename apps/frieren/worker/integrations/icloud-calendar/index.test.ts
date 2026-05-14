import { Check } from 'typebox/value'
import { describe, expect, test } from 'vitest'
import { icloudCalendarCredentialsSchema, icloudCalendarIntegration } from './index.ts'

describe('icloud-calendar integration', () => {
	test('credentials schema accepts a username + password pair', () => {
		expect(
			Check(icloudCalendarCredentialsSchema, { username: 'me@example.com', password: 'pw' })
		).toBe(true)
	})

	test('credentials schema rejects empty fields', () => {
		expect(Check(icloudCalendarCredentialsSchema, { username: '', password: 'pw' })).toBe(false)
		expect(
			Check(icloudCalendarCredentialsSchema, { username: 'me@example.com', password: '' })
		).toBe(false)
	})

	test('credentials schema rejects missing fields', () => {
		expect(Check(icloudCalendarCredentialsSchema, { username: 'me@example.com' })).toBe(false)
	})

	test('integration produces a single icloud-calendar command on connect', () => {
		const integration = icloudCalendarIntegration()
		expect(integration.id).toBe('icloud-calendar')
		const commands =
			integration.commands?.(
				{ username: 'me@example.com', password: 'pw' },
				{ accountId: 'default' }
			) ?? []
		expect(commands).toHaveLength(1)
		expect(commands[0].name).toBe('icloud-calendar')
	})
})
