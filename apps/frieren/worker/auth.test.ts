import { describe, expect, test } from 'vitest'
import { actingUserId } from './auth.ts'

// The real ids are in auth.ts (public identifiers of our own OAuth apps); the tests name their
// own so they assert the RULE, not today's ids.
const OURS = ['kodama-desktop-prod', 'kodama-desktop-dev']

describe('actingUserId', () => {
	test('a browser session token acts as its user', () => {
		expect(
			actingUserId({ tokenType: 'session_token', isAuthenticated: true, userId: 'user_1' }, OURS)
		).toBe('user_1')
	})

	test("the daemon's OAuth token acts as its user, on either instance", () => {
		for (const clientId of OURS) {
			expect(
				actingUserId(
					{ tokenType: 'oauth_token', isAuthenticated: true, userId: 'user_1', clientId },
					OURS
				)
			).toBe('user_1')
		}
	})

	test('an OAuth token from another client is refused, however valid', () => {
		// The one check `@clerk/backend` does not do for us: it verifies the token came from our
		// instance, not from our application. Any other OAuth app (or a dynamically registered
		// one) would otherwise read and write the consenting user's whole Volume.
		expect(
			actingUserId(
				{
					tokenType: 'oauth_token',
					isAuthenticated: true,
					userId: 'user_1',
					clientId: 'someone-elses-app'
				},
				OURS
			)
		).toBeNull()
		// …including a token with no client at all.
		expect(
			actingUserId({ tokenType: 'oauth_token', isAuthenticated: true, userId: 'user_1' }, OURS)
		).toBeNull()
	})

	test('a machine token we never opted into is refused', () => {
		// `acceptsToken` already filters these out; asserted here too, because the failure mode of
		// getting it wrong is silent access to someone's whole Volume rather than a broken request.
		expect(
			actingUserId({ tokenType: 'api_key', isAuthenticated: true, userId: 'user_1' }, OURS)
		).toBeNull()
		expect(
			actingUserId({ tokenType: 'm2m_token', isAuthenticated: true, userId: null }, OURS)
		).toBeNull()
	})

	test('signed out, invalid and missing auth are all null', () => {
		expect(actingUserId(null, OURS)).toBeNull()
		expect(actingUserId(undefined, OURS)).toBeNull()
		expect(actingUserId({ tokenType: null, isAuthenticated: false }, OURS)).toBeNull()
		expect(
			actingUserId({ tokenType: 'session_token', isAuthenticated: false, userId: null }, OURS)
		).toBeNull()
	})
})
