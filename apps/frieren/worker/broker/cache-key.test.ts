import { describe, expect, test } from 'bun:test'
import { hashGrants, sandboxCacheKey } from './cache-key.ts'
import type { CapabilityGrant, SandboxContext } from './contracts.ts'

const ctx = (overrides: Partial<SandboxContext>): SandboxContext => ({
	userId: 'u1',
	appId: 'today',
	appVersion: '1.0.0',
	grants: [],
	...overrides
})

describe('cache-key', () => {
	test('grant order does not affect the hash', () => {
		const a: CapabilityGrant[] = [
			{ name: 'email.read.unread', accountId: 'work' },
			{ name: 'calendar.read.today' }
		]
		const b: CapabilityGrant[] = [
			{ name: 'calendar.read.today' },
			{ name: 'email.read.unread', accountId: 'work' }
		]
		expect(hashGrants(a)).toBe(hashGrants(b))
	})

	test('scope key order does not affect the hash', () => {
		const a: CapabilityGrant[] = [
			{ name: 'volume.read', scope: { root: '/today', readonly: true } }
		]
		const b: CapabilityGrant[] = [
			{ name: 'volume.read', scope: { readonly: true, root: '/today' } }
		]
		expect(hashGrants(a)).toBe(hashGrants(b))
	})

	test('different grants produce different hashes', () => {
		const a: CapabilityGrant[] = [{ name: 'email.read.unread', accountId: 'work' }]
		const b: CapabilityGrant[] = [{ name: 'email.read.unread', accountId: 'personal' }]
		expect(hashGrants(a)).not.toBe(hashGrants(b))
	})

	test('cache key cannot collide across users', () => {
		const k1 = sandboxCacheKey(ctx({ userId: 'u1' }))
		const k2 = sandboxCacheKey(ctx({ userId: 'u2' }))
		expect(k1).not.toBe(k2)
	})

	test('cache key cannot collide across grant sets', () => {
		const grantsA: CapabilityGrant[] = [{ name: 'email.read.unread' }]
		const grantsB: CapabilityGrant[] = [{ name: 'email.markRead' }]
		expect(sandboxCacheKey(ctx({ grants: grantsA }))).not.toBe(
			sandboxCacheKey(ctx({ grants: grantsB }))
		)
	})

	test('cache key is stable for identical context', () => {
		const grants: CapabilityGrant[] = [
			{ name: 'email.read.unread', accountId: 'work' },
			{ name: 'calendar.read.today' }
		]
		expect(sandboxCacheKey(ctx({ grants }))).toBe(sandboxCacheKey(ctx({ grants })))
	})
})
