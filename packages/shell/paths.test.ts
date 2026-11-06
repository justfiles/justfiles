import { afterEach, describe, expect, it } from 'vitest'
import { devicePath, rulesFile, shellDir, volumeCwd } from './paths.ts'

describe('volumeCwd', () => {
	const root = '/Users/me/files'

	it('maps a directory under the root to its Volume path', () => {
		expect(volumeCwd('/Users/me/files/docs', root)).toBe('/docs')
		expect(volumeCwd('/Users/me/files/docs/2026/', root)).toBe('/docs/2026')
		expect(volumeCwd('/Users/me/files/..hidden', root)).toBe('/..hidden')
	})

	it('maps the root itself to /', () => {
		expect(volumeCwd('/Users/me/files', root)).toBe('/')
		expect(volumeCwd('/Users/me/files/', root)).toBe('/')
	})

	it('maps anything outside the root to /', () => {
		expect(volumeCwd('/Users/me', root)).toBe('/')
		expect(volumeCwd('/Users/me/files2/docs', root)).toBe('/')
		expect(volumeCwd('/tmp', root)).toBe('/')
		expect(volumeCwd('/', root)).toBe('/')
	})
})

describe('devicePath', () => {
	const root = '/Users/me/files'

	it('maps a Volume path to its place under the root', () => {
		expect(devicePath('/docs/a.md', root)).toBe('/Users/me/files/docs/a.md')
		expect(devicePath('/', root)).toBe('/Users/me/files')
	})

	it('stops `..` at the root', () => {
		expect(devicePath('/../..', root)).toBe('/Users/me/files')
		expect(devicePath('/docs/../../etc', root)).toBe('/Users/me/files/etc')
	})
})

describe('rulesFile', () => {
	const has =
		(...files: string[]) =>
		(path: string) =>
			files.includes(path)

	it('is the nearest AGENTS.md in the directory or above it', () => {
		expect(rulesFile('/Users/me/ws/pages/2026', has('/Users/me/ws/AGENTS.md'))).toBe(
			'/Users/me/ws/AGENTS.md'
		)
		expect(
			rulesFile('/Users/me/ws/pages', has('/Users/me/ws/AGENTS.md', '/Users/me/ws/pages/AGENTS.md'))
		).toBe('/Users/me/ws/pages/AGENTS.md')
		expect(rulesFile('/Users/me/ws/', has('/Users/me/ws/AGENTS.md'))).toBe('/Users/me/ws/AGENTS.md')
	})

	it('is undefined when no directory up to the root has one', () => {
		expect(rulesFile('/Users/me', has('/Users/me/ws/AGENTS.md'))).toBeUndefined()
		expect(rulesFile('/', has())).toBeUndefined()
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
