import { beforeAll, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'

const { getAuthStatus, getSessionToken } = vi.hoisted(() => ({
	getAuthStatus: vi.fn().mockResolvedValue({ status: 'signed_in' }),
	getSessionToken: vi.fn().mockResolvedValue('secret-session-token')
}))
vi.mock('wxt/browser', () => ({ browser: fakeBrowser }))
vi.mock('../lib/auth.ts', () => ({ getAuthStatus, getSessionToken }))

beforeAll(async () => {
	fakeBrowser.reset()
	vi.stubGlobal('defineBackground', (register: () => void) => register())
	vi.stubEnv('WXT_FRIEREN_API_ORIGIN', 'https://justcomputer.test')
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ result: { saved: true } })))
	await import('../entrypoints/background.ts')
})

it('runs actions in the background without returning the token', async () => {
	const send = async (message: unknown) =>
		(await fakeBrowser.runtime.onMessage.trigger(message, {}, vi.fn()))[0]

	expect(await send({ type: 'auth/status' })).toEqual({
		status: 'signed_in'
	})
	const response = await send({
		type: 'run',
		appId: 'justfiles.read',
		action: 'save',
		params: { input: 'https://example.com' }
	})

	expect(response).toEqual({ status: 'success', result: { saved: true } })
	expect(JSON.stringify(response)).not.toContain('secret-session-token')
	expect(fetch).toHaveBeenCalledWith(
		'https://justcomputer.test/api/v1/apps/justfiles.read/actions/save',
		expect.objectContaining({
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer secret-session-token'
			}
		})
	)
})
