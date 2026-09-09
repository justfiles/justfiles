import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { afterEach, expect, test, vi } from 'vitest'
import { createSettingsHost } from './host.ts'
import { serveSettings, settingsClient } from './http.ts'

afterEach(() => vi.unstubAllGlobals())

test('the host connection round-trips wallpaper bytes and service errors', async () => {
	const fs = volume(memStore())
	const host = createSettingsHost({
		appearance: { volume: fs, wallpaper: '/wallpaper', dockMaterial: '/dock' }
	})
	vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
		expect(new Headers(options.headers).get('authorization')).toBe('Bearer test')
		return serveSettings(new Request(`https://host${url}`, options), host)
	})
	const client = settingsClient('/settings', async () => ({ authorization: 'Bearer test' }))
	const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
	await client.writeWallpaper({ bytes })
	expect(await client.readWallpaper({})).toEqual(bytes)
	await client.writeWallpaper({ bytes: null })
	expect(await client.readWallpaper({})).toBeNull()
	await expect(client.readUsage({})).rejects.toThrow('SETTINGS_UNAVAILABLE')
})

test('only known, own service methods accept JSON POST requests', async () => {
	const run = vi.fn(async () => null)
	const host = Object.assign(Object.create({ readUser: run }), { readUsage: run })
	for (const method of ['constructor', 'toString', '__proto__', 'readUser', 'unknown']) {
		const response = await serveSettings(
			new Request(`https://host/settings/${method}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}'
			}),
			host
		)
		expect(response.status).toBe(404)
	}
	expect((await serveSettings(new Request('https://host/settings/readUsage'), host)).status).toBe(
		405
	)
	expect(
		(
			await serveSettings(
				new Request('https://host/settings/readUsage', { method: 'POST', body: '{}' }),
				host
			)
		).status
	).toBe(415)
	expect(run).not.toHaveBeenCalled()
})

test('interactive sign-in crosses the host connection with progress, opening and cancellation', async () => {
	const { hostAccounts } = await import('@justfiles/app/accounts/host')
	const openUrl = vi.fn()
	const accounts = hostAccounts(
		[
			{
				id: 'chatgpt',
				name: 'ChatGPT',
				capabilities: {},
				auth: {
					ui: { kind: 'interactive' },
					acquire: ({ notify, signal }) => {
						notify?.({ verificationUrl: 'https://example.com/sign-in', userCode: 'ABCD' })
						return new Promise((_resolve, reject) =>
							signal?.addEventListener('abort', () => reject(signal.reason))
						)
					}
				}
			}
		],
		volume(memStore())
	).admin
	const host = createSettingsHost({ accounts, openUrl })
	vi.stubGlobal('fetch', (url: string, options: RequestInit) =>
		serveSettings(new Request(url, options), host)
	)
	const client = settingsClient('https://host/settings', async () => ({}))
	const ref = { providerId: 'chatgpt', operationId: 'attempt-1' }
	await client.beginAccountConnection(ref)
	expect(await client.readAccountConnection(ref)).toMatchObject({
		status: 'pending',
		prompt: { userCode: 'ABCD' }
	})
	await client.openAccountConnection(ref)
	expect(openUrl).toHaveBeenCalledWith('https://example.com/sign-in')
	await client.cancelAccountConnection(ref)
	expect(await client.readAccountConnection(ref)).toMatchObject({ status: 'cancelled' })
	await expect(client.openAccountConnection(ref)).rejects.toThrow('SETTINGS_UNAVAILABLE')
	expect(await client.readAccountConnection({ ...ref, operationId: 'unknown' })).toMatchObject({
		status: 'expired'
	})
	expect(await client.listAccounts({})).toEqual([])
})
