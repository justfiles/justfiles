import { describe, expect, test } from 'vitest'
import { LEGACY_HOST_REDIRECTS, legacyHostRedirect } from './legacy-redirect.ts'

describe('legacyHostRedirect', () => {
	test('307s a retired staging host to its replacement, preserving path + query', () => {
		const res = legacyHostRedirect(
			new Request('https://staging.spud.computer/store/catalog.json?x=1#h')
		)
		expect(res?.status).toBe(307)
		expect(res?.headers.get('location')).toBe(
			'https://staging.mykodama.app/store/catalog.json?x=1#h'
		)
	})

	test('leaves the new host alone (no redirect)', () => {
		expect(legacyHostRedirect(new Request('https://staging.mykodama.app/'))).toBeUndefined()
	})

	test('does NOT redirect production spud.computer — prod cutover is separate', () => {
		// Guards the prod-safety invariant: this worker ships to prod too, so the
		// prod host must not be in the map until its own cutover.
		expect(legacyHostRedirect(new Request('https://spud.computer/'))).toBeUndefined()
		expect(LEGACY_HOST_REDIRECTS['spud.computer']).toBeUndefined()
	})
})
