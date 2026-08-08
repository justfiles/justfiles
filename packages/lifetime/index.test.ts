import { describe, expect, it } from 'vitest'
import { createLifetimeGate, StaleLifetimeError } from './index.ts'

describe('createLifetimeGate', () => {
	it('keeps the current token valid until replacement', () => {
		const gate = createLifetimeGate('first')
		const token = gate.current()

		expect(gate.current()).toBe(token)
		expect(() => token.assertCurrent()).not.toThrow()
	})

	it('invalidates an old token when replacing with the same value', () => {
		const gate = createLifetimeGate('same')
		const old = gate.current()
		const current = gate.replace('same')

		expect(current).not.toBe(old)
		expect(() => old.assertCurrent()).toThrow(StaleLifetimeError)
		expect(() => current.assertCurrent()).not.toThrow()
	})

	it('reports stable stale error details', () => {
		const expected = { generation: 1 }
		const actual = { generation: 2 }
		const gate = createLifetimeGate(expected)
		const stale = gate.current()
		gate.replace(actual)

		try {
			stale.assertCurrent()
			expect.unreachable('expected a stale lifetime error')
		} catch (error) {
			expect(error).toBeInstanceOf(StaleLifetimeError)
			expect(error).toMatchObject({
				name: 'StaleLifetimeError',
				expected,
				actual
			})
		}
	})

	it('keeps independent gates isolated', () => {
		const first = createLifetimeGate(1)
		const second = createLifetimeGate(1)
		const secondToken = second.current()

		first.replace(2)

		expect(() => secondToken.assertCurrent()).not.toThrow()
		expect(second.current()).toBe(secondToken)
	})
})
