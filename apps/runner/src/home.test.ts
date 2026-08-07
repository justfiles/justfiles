import { expect, test, vi } from 'vitest'

const refresh = vi.hoisted(() => vi.fn())
vi.mock('./catalog', () => ({ listApps: vi.fn(async () => []), refresh }))

import { route } from './home'

test('the refresh button runs the catalog refresh then returns home', async () => {
	const env = {} as CloudflareBindings
	const response = await route.fetch(
		new Request('https://example.com/refresh', { method: 'POST' }),
		env,
		{} as ExecutionContext
	)

	expect(refresh).toHaveBeenCalledWith(env)
	expect(response.status).toBe(303)
	expect(response.headers.get('location')).toBe('/')
})
