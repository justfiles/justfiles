import { describe, expect, test } from 'bun:test'
import { appLoaderCacheKey, type CapabilityGrant, grantsHash } from './app-loader-key'

describe('appLoaderCacheKey', () => {
	const base = {
		appId: 'crossword',
		version: '1.0.0',
		userId: 'user-1',
		grants: [] as readonly CapabilityGrant[]
	}

	test('composes appId, version, userId, and a grants hash', () => {
		const key = appLoaderCacheKey(base)
		expect(key.startsWith('crossword:1.0.0:user-1:')).toBe(true)
	})

	test('changes when the app version changes', () => {
		expect(appLoaderCacheKey(base)).not.toEqual(appLoaderCacheKey({ ...base, version: '1.0.1' }))
	})

	test('changes when the user changes', () => {
		expect(appLoaderCacheKey(base)).not.toEqual(appLoaderCacheKey({ ...base, userId: 'user-2' }))
	})

	test('changes when grants change', () => {
		const withGrant = appLoaderCacheKey({
			...base,
			grants: [{ capability: 'email', scope: 'read.unread' }]
		})
		expect(withGrant).not.toEqual(appLoaderCacheKey(base))
	})

	test('is stable across grant ordering', () => {
		const a: CapabilityGrant[] = [
			{ capability: 'email', scope: 'read.unread' },
			{ capability: 'calendar', scope: 'read', accountId: 'a1' }
		]
		const b: CapabilityGrant[] = [
			{ capability: 'calendar', scope: 'read', accountId: 'a1' },
			{ capability: 'email', scope: 'read.unread' }
		]
		expect(appLoaderCacheKey({ ...base, grants: a })).toEqual(
			appLoaderCacheKey({ ...base, grants: b })
		)
	})
})

describe('grantsHash', () => {
	test('separates accountId variants of the same scope', () => {
		const a = grantsHash([{ capability: 'email', scope: 'read.unread', accountId: 'a1' }])
		const b = grantsHash([{ capability: 'email', scope: 'read.unread', accountId: 'a2' }])
		expect(a).not.toEqual(b)
	})

	test('matches across reordering', () => {
		const a = grantsHash([
			{ capability: 'email', scope: 'read.unread' },
			{ capability: 'calendar', scope: 'read' }
		])
		const b = grantsHash([
			{ capability: 'calendar', scope: 'read' },
			{ capability: 'email', scope: 'read.unread' }
		])
		expect(a).toEqual(b)
	})
})
