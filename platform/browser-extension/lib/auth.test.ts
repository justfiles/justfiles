import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAuthStatus, getSessionToken } from './auth.ts'

const { createClerkClient } = vi.hoisted(() => ({ createClerkClient: vi.fn() }))
vi.mock('@clerk/chrome-extension/client', () => ({ createClerkClient }))

describe('background auth', () => {
	beforeEach(() => {
		createClerkClient.mockReset()
		vi.stubEnv('WXT_CLERK_PUBLISHABLE_KEY', 'pk_test_public')
		vi.stubEnv('WXT_CLERK_SYNC_HOST', 'http://localhost')
	})

	it('returns signed out when Clerk has no session', async () => {
		createClerkClient.mockResolvedValue({ session: null })

		expect(await getAuthStatus()).toEqual({ status: 'signed_out' })
	})

	it('gets a fresh token without exposing it in the status response', async () => {
		const getToken = vi.fn().mockResolvedValue('session-token')
		createClerkClient.mockResolvedValue({ session: { getToken } })

		expect(await getSessionToken()).toBe('session-token')
		expect(await getAuthStatus()).toEqual({ status: 'signed_in' })
		expect(createClerkClient).toHaveBeenCalledTimes(2)
		expect(createClerkClient).toHaveBeenLastCalledWith({
			publishableKey: 'pk_test_public',
			syncHost: 'http://localhost',
			background: true
		})
		expect(getToken).toHaveBeenCalledTimes(2)
	})

	it('returns signed out when the session no longer yields a token', async () => {
		createClerkClient.mockResolvedValue({
			session: { getToken: vi.fn().mockResolvedValue(null) }
		})

		expect(await getAuthStatus()).toEqual({ status: 'signed_out' })
	})
})
