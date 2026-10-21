import { afterEach, describe, expect, it } from 'vitest'
import { devicePath, shellDir, volumeCwd } from './paths.ts'

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

describe('devicePath', () => {
	const root = '/Users/me/files'

	it('maps a Volume path to its place under the root', () => {
		expect(devicePath('/notes/a.md', root)).toBe('/Users/me/files/notes/a.md')
		expect(devicePath('/', root)).toBe('/Users/me/files')
	})

	it('stops `..` at the root', () => {
		expect(devicePath('/../..', root)).toBe('/Users/me/files')
		expect(devicePath('/notes/../../etc', root)).toBe('/Users/me/files/etc')
	})
})

describe('shellDir', () => {
	afterEach(() => {
		delete process.env.GHOST_SHELL_DIR
	})

	it('is GHOST_SHELL_DIR when it is set', () => {
		process.env.GHOST_SHELL_DIR = '/tmp/second-shell'
		expect(shellDir()).toBe('/tmp/second-shell')
	})
})
