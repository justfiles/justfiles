import { expect, test } from 'vitest'
import { CapabilityError, fromWire, toWire } from './error.ts'

test('CapabilityError carries the code as message + branchable fields', () => {
	const e = new CapabilityError('CAPABILITY_OFFLINE', 'ai', 'generateText')
	expect(e).toBeInstanceOf(Error)
	expect(e.name).toBe('CapabilityError')
	expect(e.message).toBe('CAPABILITY_OFFLINE')
	expect(e).toMatchObject({ code: 'CAPABILITY_OFFLINE', capability: 'ai', method: 'generateText' })
})

test('toWire/fromWire round-trips a CapabilityError', () => {
	const e = new CapabilityError('CAPABILITY_UNAVAILABLE', 'volume', 'scan')
	expect(toWire(e)).toEqual({
		message: 'CAPABILITY_UNAVAILABLE',
		code: 'CAPABILITY_UNAVAILABLE',
		capability: 'volume',
		method: 'scan'
	})
	const back = fromWire(toWire(e))
	expect(back).toBeInstanceOf(CapabilityError)
	expect(back.code).toBe('CAPABILITY_UNAVAILABLE')
	expect(back).toMatchObject({ capability: 'volume', method: 'scan' })
})

// One vocabulary: frieren's UNAVAILABLE/INVALID_INPUT/OFFLINE and the broker's
// DENIED/FAILED all live in this module and serialise identically.
test('unifies the frieren and broker code sets', () => {
	for (const code of [
		'CAPABILITY_UNAVAILABLE',
		'CAPABILITY_INVALID_INPUT',
		'CAPABILITY_OFFLINE',
		'CAPABILITY_DENIED',
		'CAPABILITY_FAILED'
	] as const) {
		expect(fromWire(toWire(new CapabilityError(code))).code).toBe(code)
	}
})

test('toWire stringifies a non-Error throw', () => {
	expect(toWire('boom')).toEqual({ message: 'boom' })
})

test('fromWire fills capability/method from the fallback when the wire omits them', () => {
	const back = fromWire(
		{ message: 'CAPABILITY_UNAVAILABLE', code: 'CAPABILITY_UNAVAILABLE' },
		{ capability: 'integrations', method: 'list' }
	)
	expect(back).toMatchObject({ capability: 'integrations', method: 'list' })
})
