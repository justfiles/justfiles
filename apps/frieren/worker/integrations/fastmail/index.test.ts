import { Check } from 'typebox/value'
import { describe, expect, test } from 'vitest'
import { fastmailCredentialsSchema, fastmailIntegration } from './index.ts'

describe('fastmail integration', () => {
	test('credentials schema accepts a non-empty token', () => {
		expect(Check(fastmailCredentialsSchema, { token: 'abc' })).toBe(true)
	})

	test('credentials schema rejects empty token', () => {
		expect(Check(fastmailCredentialsSchema, { token: '' })).toBe(false)
	})

	test('credentials schema rejects missing token', () => {
		expect(Check(fastmailCredentialsSchema, {})).toBe(false)
	})

	test('integration produces a fastmail command on connect', () => {
		const integration = fastmailIntegration()
		expect(integration.id).toBe('fastmail')
		const commands = integration.commands?.({ token: 'abc' }, { accountId: 'default' }) ?? []
		expect(commands).toHaveLength(1)
		expect(commands[0].name).toBe('fastmail')
	})
})
