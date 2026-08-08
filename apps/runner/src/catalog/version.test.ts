import { describe, expect, it } from 'vitest'
import { compare, parseVersion, version } from './version'

describe('parseVersion', () => {
	it('strips the v and fills the missing components', () => {
		expect(parseVersion('v0.4.1')).toBe('0.4.1')
		expect(parseVersion('v6.9')).toBe('6.9.0')
		expect(parseVersion('6.9')).toBe('6.9.0')
		expect(parseVersion('v2')).toBe('2.0.0')
	})

	it('keeps a prerelease or build suffix', () => {
		expect(parseVersion('v1.2.3-rc1')).toBe('1.2.3-rc1')
		expect(parseVersion('v1.0.0+build.5')).toBe('1.0.0+build.5')
	})

	it('rejects a tag that is not a version', () => {
		// A monorepo's latest release can belong to another package.
		expect(parseVersion('create-vite@5.0.0')).toBeNull()
		expect(parseVersion('nightly')).toBeNull()
		// Rung 3 skips these; rungs 1–2 have no lower rung to fall to.
		expect(() => version('nightly')).toThrow('not a version')
	})
})

describe('compare', () => {
	const newestFirst = (tags: string[]) =>
		tags
			.map((t) => [t, version(t)] as const)
			.sort((a, b) => compare(b[1], a[1]))
			.map(([tag]) => tag)

	it('orders numerically, not lexically', () => {
		expect(compare('1.10.0', '1.9.0')).toBeGreaterThan(0)
	})

	it('sorts a release above the prerelease it precedes', () => {
		expect(compare('2.0.0', '2.0.0-rc1')).toBeGreaterThan(0)
		expect(compare('2.0.0-rc1', '1.9.9')).toBeGreaterThan(0)
	})

	it('picks the newest tag of a mixed set', () => {
		expect(newestFirst(['v1.2.3', 'v1.10.0', 'v2.0.0-rc1', 'v2.0.0', 'v6.9', 'v0.4.1'])).toEqual([
			'v6.9',
			'v2.0.0',
			'v2.0.0-rc1',
			'v1.10.0',
			'v1.2.3',
			'v0.4.1'
		])
	})
})
