import { describe, expect, it } from 'vitest'
import { volumeCwd } from './paths.ts'

describe('volumeCwd', () => {
	const root = '/Users/me/files'

	it('maps a directory under the root to its Volume path', () => {
		expect(volumeCwd('/Users/me/files/notes', root)).toBe('/notes')
		expect(volumeCwd('/Users/me/files/notes/2026/', root)).toBe('/notes/2026')
		expect(volumeCwd('/Users/me/files/..hidden', root)).toBe('/..hidden')
	})

	it('maps the root itself to /', () => {
		expect(volumeCwd('/Users/me/files', root)).toBe('/')
		expect(volumeCwd('/Users/me/files/', root)).toBe('/')
	})

	it('maps anything outside the root to /', () => {
		expect(volumeCwd('/Users/me', root)).toBe('/')
		expect(volumeCwd('/Users/me/files2/notes', root)).toBe('/')
		expect(volumeCwd('/tmp', root)).toBe('/')
		expect(volumeCwd('/', root)).toBe('/')
	})
})
