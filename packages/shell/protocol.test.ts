import { describe, expect, it } from 'vitest'
import { asRequest, decoder, encode } from './protocol.ts'

describe('framing', () => {
	it('is one JSON value per line', () => {
		const line = encode({ type: 'ask', id: 'a', text: 'two\nlines', cwd: '/' })
		expect(line.endsWith('\n')).toBe(true)
		expect(line.slice(0, -1)).not.toContain('\n')
		expect(JSON.parse(line)).toEqual({ type: 'ask', id: 'a', text: 'two\nlines', cwd: '/' })
	})

	it('joins lines split across chunks and splits chunks holding several', () => {
		const got: unknown[] = []
		const feed = decoder((message) => got.push(message))
		const wire = encode({ type: 'abort' }) + encode({ type: 'status' }) + encode({ type: 'new' })
		feed(wire.slice(0, 5))
		expect(got).toEqual([])
		feed(wire.slice(5, 25))
		feed(wire.slice(25))
		expect(got).toEqual([{ type: 'abort' }, { type: 'status' }, { type: 'new' }])
	})

	it('reports a line that is not JSON and keeps going', () => {
		const got: unknown[] = []
		const bad: string[] = []
		const feed = decoder(
			(message) => got.push(message),
			(line) => bad.push(line)
		)
		feed(`{oops\n\n${encode({ type: 'abort' })}`)
		expect(bad).toEqual(['{oops'])
		expect(got).toEqual([{ type: 'abort' }])
	})
})

describe('asRequest', () => {
	it('accepts the four requests', () => {
		for (const request of [
			{ type: 'ask', id: 'a', text: 'hi', cwd: '/notes', steer: true },
			{ type: 'abort' },
			{ type: 'new', handoff: 'carry on' },
			{ type: 'status' }
		])
			expect(asRequest(request)).toEqual(request)
	})

	it('refuses anything else', () => {
		for (const message of [
			null,
			'ask',
			{ type: 'ask', id: 'a', text: 'hi' },
			{ type: 'ask', id: 1, text: 'hi', cwd: '/' },
			{ type: 'new', handoff: 3 },
			{ type: 'login' }
		])
			expect(asRequest(message)).toBeUndefined()
	})
})
