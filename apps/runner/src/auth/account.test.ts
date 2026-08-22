import { expect, test } from 'vitest'
import { leaseRefresh, putAccount, readAccount, saveRefresh } from './account'
import { toBase64Url } from './secret'
import { testDatabase } from './test-db'
import { tokenCodec } from './token'

const codec = tokenCodec(toBase64Url(new Uint8Array(32).fill(7)))

test('stores OAuth tokens sealed and restores sorted scopes', async () => {
	const { database, sqlite } = testDatabase()
	const version = await putAccount(database, codec, {
		userId: 'user_1',
		accessToken: 'access-token',
		refreshToken: 'refresh-token',
		accessExpiresAt: 5_000,
		scopes: ['profile', 'openid', 'openid']
	})
	const stored = sqlite
		.prepare('SELECT access_token, refresh_token FROM accounts WHERE user_id = ?')
		.get('user_1') as { access_token: string; refresh_token: string }

	expect(version).toBe(1)
	expect(stored.access_token).not.toContain('access-token')
	expect(stored.refresh_token).not.toContain('refresh-token')
	expect(await readAccount(database, codec, 'user_1')).toEqual({
		userId: 'user_1',
		accessToken: 'access-token',
		refreshToken: 'refresh-token',
		accessExpiresAt: 5_000,
		scopes: ['openid', 'profile'],
		tokenVersion: 1
	})
})

test('leases one refresh and saves a rotated refresh token once', async () => {
	const { database } = testDatabase()
	await putAccount(database, codec, {
		userId: 'user_1',
		accessToken: 'access-1',
		refreshToken: 'refresh-1',
		accessExpiresAt: 5_000,
		scopes: ['openid']
	})

	expect(await leaseRefresh(database, 'user_1', 1_000)).toBe(2)
	expect(await leaseRefresh(database, 'user_1', 1_000)).toBeNull()
	expect(
		await saveRefresh(
			database,
			codec,
			{
				userId: 'user_1',
				accessToken: 'access-2',
				refreshToken: 'refresh-2',
				accessExpiresAt: 9_000
			},
			2,
			1_500
		)
	).toBe(true)
	expect(
		await saveRefresh(
			database,
			codec,
			{
				userId: 'user_1',
				accessToken: 'stale',
				refreshToken: 'stale',
				accessExpiresAt: 10_000
			},
			2,
			1_500
		)
	).toBe(false)
	expect(await readAccount(database, codec, 'user_1')).toMatchObject({
		accessToken: 'access-2',
		refreshToken: 'refresh-2',
		tokenVersion: 2
	})
})

test('an expired lease cannot save through a newer lease', async () => {
	const { database } = testDatabase()
	await putAccount(database, codec, {
		userId: 'user_1',
		accessToken: 'access-1',
		refreshToken: 'refresh-1',
		accessExpiresAt: 5_000,
		scopes: ['openid']
	})
	const old = await leaseRefresh(database, 'user_1', 1_000)
	const current = await leaseRefresh(database, 'user_1', 31_000)
	const tokens = {
		userId: 'user_1',
		accessToken: 'access-2',
		refreshToken: 'refresh-2',
		accessExpiresAt: 9_000
	}

	expect(old).toBe(2)
	expect(current).toBe(3)
	expect(await saveRefresh(database, codec, tokens, old ?? 0, 31_001)).toBe(false)
	expect(await saveRefresh(database, codec, tokens, current ?? 0, 31_001)).toBe(true)
})
