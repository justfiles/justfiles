import { beforeEach, describe, expect, test, vi } from 'vitest'

const auth = vi.hoisted(() => ({ value: null as unknown }))

vi.mock('@clerk/hono', () => ({
	clerkMiddleware: () => async (_context: unknown, next: () => Promise<void>) => next(),
	getAuth: () => auth.value
}))
vi.mock('./frieren.ts', () => ({ Frieren: class {} }))

import worker from './index.ts'

function env() {
	const ownerFetch = vi.fn(async (request: Request) =>
		Response.json({ userId: request.headers.get('x-user-id') })
	)
	const owner = { fetch: ownerFetch }
	const namespace = {
		idFromName: vi.fn((name: string) => `owner:${name}`),
		get: vi.fn(() => owner)
	}
	return { bindings: { FRIEREN: namespace } as never, namespace, ownerFetch }
}

describe('authenticated app action routing', () => {
	beforeEach(() => {
		auth.value = null
	})

	test('returns 401 before reaching a Durable Object without a supported credential', async () => {
		const { bindings, namespace, ownerFetch } = env()
		const response = await worker.fetch(
			new Request('https://example.test/api/v1/apps'),
			bindings,
			{} as never
		)
		expect(response.status).toBe(401)
		expect(await response.json()).toEqual({
			error: { code: 'unauthorized', message: 'authentication is required' }
		})
		expect(namespace.idFromName).not.toHaveBeenCalled()
		expect(ownerFetch).not.toHaveBeenCalled()
	})

	test('keeps the existing plain-text 401 for unrelated API routes', async () => {
		const { bindings } = env()
		const response = await worker.fetch(
			new Request('https://example.test/api/ai/model'),
			bindings,
			{} as never
		)
		expect(response.status).toBe(401)
		expect(await response.text()).toBe('Unauthorized')
	})

	test("forwards a valid session token to that Clerk user's Durable Object", async () => {
		auth.value = {
			tokenType: 'session_token',
			isAuthenticated: true,
			userId: 'user_123'
		}
		const { bindings, namespace, ownerFetch } = env()
		const response = await worker.fetch(
			new Request('https://example.test/api/v1/apps', {
				headers: { authorization: 'Bearer session-token' }
			}),
			bindings,
			{} as never
		)
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ userId: 'user_123' })
		expect(namespace.idFromName).toHaveBeenCalledWith('user_123')
		expect(namespace.get).toHaveBeenCalledWith('owner:user_123')
		expect(ownerFetch).toHaveBeenCalledOnce()
	})
})
