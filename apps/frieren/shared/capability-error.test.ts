import { describe, expect, test } from 'vitest'
import { capabilityError, fromWireError, toWireError } from './capability-error.ts'

describe('capability-error', () => {
	test('capabilityError carries code as message + branchable fields', () => {
		const err = capabilityError('CAPABILITY_OFFLINE', 'ai', 'generateText')
		expect(err).toBeInstanceOf(Error)
		expect(err.message).toBe('CAPABILITY_OFFLINE')
		expect(err).toMatchObject({
			code: 'CAPABILITY_OFFLINE',
			capability: 'ai',
			method: 'generateText'
		})
	})

	test('toWireError extracts the capability fields from an Error', () => {
		expect(toWireError(capabilityError('CAPABILITY_UNAVAILABLE', 'volume', 'readFile'))).toEqual({
			message: 'CAPABILITY_UNAVAILABLE',
			code: 'CAPABILITY_UNAVAILABLE',
			capability: 'volume',
			method: 'readFile'
		})
	})

	test('toWireError stringifies a non-Error throw', () => {
		expect(toWireError('boom')).toEqual({ message: 'boom' })
	})

	test('wire round-trips through fromWireError', () => {
		const wire = toWireError(capabilityError('CAPABILITY_INVALID_INPUT', 'volume', 'writeFile'))
		expect(fromWireError(wire)).toMatchObject({
			message: 'CAPABILITY_INVALID_INPUT',
			code: 'CAPABILITY_INVALID_INPUT',
			capability: 'volume',
			method: 'writeFile'
		})
	})

	test('fromWireError fills capability/method from the fallback when absent', () => {
		const err = fromWireError(
			{ message: 'CAPABILITY_UNAVAILABLE', code: 'CAPABILITY_UNAVAILABLE' },
			{ capability: 'integrations', method: 'list' }
		)
		expect(err).toMatchObject({ capability: 'integrations', method: 'list' })
	})

	test('fromWireError prefers the wire fields over the fallback', () => {
		const err = fromWireError(
			{ message: 'x', capability: 'ai', method: 'generateText' },
			{ capability: 'integrations', method: 'list' }
		)
		expect(err).toMatchObject({ capability: 'ai', method: 'generateText' })
	})
})
