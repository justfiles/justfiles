import type { Database } from './db'
import type { TokenCodec } from './token'

const REFRESH_LEASE_MS = 30_000

interface Account {
	userId: string
	accessToken: string
	refreshToken: string
	accessExpiresAt: number
	scopes: string[]
	tokenVersion: number
}

interface AccountRow {
	userId: string
	accessToken: string
	refreshToken: string
	accessExpiresAt: number
	scopes: string
	tokenVersion: number
}

export async function putAccount(
	database: Database,
	codec: TokenCodec,
	account: Omit<Account, 'tokenVersion'>
): Promise<number> {
	const row = await database.first<{ tokenVersion: number }>(
		`INSERT INTO accounts
			(user_id, access_token, refresh_token, access_expires_at, scopes)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (user_id) DO UPDATE SET
			access_token = excluded.access_token,
			refresh_token = excluded.refresh_token,
			access_expires_at = excluded.access_expires_at,
			scopes = excluded.scopes,
			token_version = accounts.token_version + 1,
			refresh_lease_until = NULL
		 RETURNING token_version AS tokenVersion`,
		account.userId,
		await codec.seal(account.accessToken, account.userId, 'access'),
		await codec.seal(account.refreshToken, account.userId, 'refresh'),
		account.accessExpiresAt,
		JSON.stringify(sorted(account.scopes))
	)
	if (!row) throw new Error('failed to store account')
	return row.tokenVersion
}

export async function readAccount(
	database: Database,
	codec: TokenCodec,
	userId: string
): Promise<Account | null> {
	const row = await database.first<AccountRow>(
		`SELECT user_id AS userId, access_token AS accessToken, refresh_token AS refreshToken,
			access_expires_at AS accessExpiresAt, scopes, token_version AS tokenVersion
		 FROM accounts WHERE user_id = ?`,
		userId
	)
	if (!row) return null
	return {
		...row,
		accessToken: await codec.open(row.accessToken, userId, 'access'),
		refreshToken: await codec.open(row.refreshToken, userId, 'refresh'),
		scopes: scopes(row.scopes)
	}
}

export async function leaseRefresh(
	database: Database,
	userId: string,
	now = Date.now()
): Promise<number | null> {
	const row = await database.first<{ tokenVersion: number }>(
		`UPDATE accounts SET
			refresh_lease_until = ?, token_version = token_version + 1
		 WHERE user_id = ? AND (refresh_lease_until IS NULL OR refresh_lease_until <= ?)
		 RETURNING token_version AS tokenVersion`,
		now + REFRESH_LEASE_MS,
		userId,
		now
	)
	return row?.tokenVersion ?? null
}

export async function saveRefresh(
	database: Database,
	codec: TokenCodec,
	account: Omit<Account, 'scopes' | 'tokenVersion'>,
	version: number,
	now: number
): Promise<boolean> {
	const row = await database.first<{ tokenVersion: number }>(
		`UPDATE accounts SET
			access_token = ?, refresh_token = ?, access_expires_at = ?,
			refresh_lease_until = NULL
		 WHERE user_id = ? AND token_version = ? AND refresh_lease_until > ?
		 RETURNING token_version AS tokenVersion`,
		await codec.seal(account.accessToken, account.userId, 'access'),
		await codec.seal(account.refreshToken, account.userId, 'refresh'),
		account.accessExpiresAt,
		account.userId,
		version,
		now
	)
	return row !== null
}

export async function deleteAccount(database: Database, userId: string): Promise<void> {
	await database.run('DELETE FROM accounts WHERE user_id = ?', userId)
}

const sorted = (values: string[]): string[] => [...new Set(values)].sort()

const scopes = (value: string): string[] => {
	const parsed: unknown = JSON.parse(value)
	if (!Array.isArray(parsed) || !parsed.every((scope) => typeof scope === 'string'))
		throw new Error('account has invalid scopes')
	return parsed
}
