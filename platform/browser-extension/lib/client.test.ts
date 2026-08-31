import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppActionsError, inspect, list, run } from './client.ts'

const { getSessionToken } = vi.hoisted(() => ({ getSessionToken: vi.fn() }))
vi.mock('./auth.ts', () => ({ getSessionToken }))

describe('app actions client', () => {
	beforeEach(() => {
		getSessionToken.mockReset()
		vi.stubEnv('WXT_FRIEREN_API_ORIGIN', 'https://justcomputer.test')
		vi.unstubAllGlobals()
	})

	it('gets a fresh token and adds the bearer header to every request', async () => {
		getSessionToken.mockResolvedValueOnce('first-token').mockResolvedValueOnce('second-token')
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json([]))
			.mockResolvedValueOnce(Response.json({ id: 'justfiles.read', name: 'Read', actions: {} }))
		vi.stubGlobal('fetch', fetch)

		await list()
		await inspect('justfiles.read')

		expect(fetch).toHaveBeenNthCalledWith(
			1,
			'https://justcomputer.test/api/v1/apps',
			expect.objectContaining({ headers: { authorization: 'Bearer first-token' } })
		)
		expect(fetch).toHaveBeenNthCalledWith(
			2,
			'https://justcomputer.test/api/v1/apps/justfiles.read',
			expect.objectContaining({ headers: { authorization: 'Bearer second-token' } })
		)
	})

	it('posts JSON params and unwraps the action result', async () => {
		getSessionToken.mockResolvedValue('session-token')
		const fetch = vi.fn().mockResolvedValue(Response.json({ result: { saved: true } }))
		vi.stubGlobal('fetch', fetch)

		expect(await run('app/id', 'save item', { input: 'https://example.com' })).toEqual({
			saved: true
		})
		expect(fetch).toHaveBeenCalledWith(
			'https://justcomputer.test/api/v1/apps/app%2Fid/actions/save%20item',
			expect.objectContaining({
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: 'Bearer session-token'
				},
				body: '{"input":"https://example.com"}'
			})
		)
	})

	it('does not call the gateway while signed out', async () => {
		getSessionToken.mockResolvedValue(null)
		const fetch = vi.fn()
		vi.stubGlobal('fetch', fetch)

		await expect(list()).rejects.toMatchObject({ code: 'signed_out' })
		expect(fetch).not.toHaveBeenCalled()
	})

	it('preserves safe gateway error codes', async () => {
		getSessionToken.mockResolvedValue('session-token')
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					Response.json(
						{ error: { code: 'app_not_installed', message: 'app is not installed' } },
						{ status: 404 }
					)
				)
		)

		await expect(run('justfiles.read', 'save', {})).rejects.toEqual(
			new AppActionsError('app_not_installed', 'app is not installed')
		)
	})
})
