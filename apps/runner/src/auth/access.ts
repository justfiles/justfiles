import {
	deleteLeasedAccount,
	leaseRefresh,
	readAccount,
	releaseRefresh,
	saveRefresh
} from './account'
import type { Database } from './db'
import { discover, OAuthGrantExpired, refreshAccessToken } from './oauth'
import type { TokenCodec } from './token'

const REFRESH_AHEAD_MS = 60_000
const REFRESH_POLL_MS = 250
const REFRESH_POLL_LIMIT = 40

type OAuthConfig = {
	CLERK_ISSUER: string
	CLERK_CLIENT_ID: string
	CLERK_CLIENT_SECRET: string
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** Get a live token. One caller refreshes it while other callers watch the account row. */
export async function accessToken(
	database: Database,
	codec: TokenCodec,
	config: OAuthConfig,
	userId: string,
	fetcher: Fetcher = fetch,
	now = Date.now()
): Promise<string> {
	for (let poll = 0; ; poll++) {
		const account = await readAccount(database, codec, userId)
		if (!account) throw new Error('Runner account is not connected')
		if (account.accessExpiresAt > now + REFRESH_AHEAD_MS) return account.accessToken

		const version = await leaseRefresh(database, userId, now)
		if (version === null) {
			if (account.accessExpiresAt > now) return account.accessToken
			if (poll === REFRESH_POLL_LIMIT)
				throw new Error('Runner account token refresh is in progress')
			await scheduler.wait(REFRESH_POLL_MS)
			continue
		}

		try {
			const tokens = await refreshAccessToken(
				await discover(config, fetcher),
				config,
				account.refreshToken,
				fetcher,
				now
			)
			if (!(await saveRefresh(database, codec, { userId, ...tokens }, version, now)))
				throw new Error('Runner account token refresh lost its lease')
			return tokens.accessToken
		} catch (error) {
			if (error instanceof OAuthGrantExpired) await deleteLeasedAccount(database, userId, version)
			else await releaseRefresh(database, userId, version)
			throw error
		}
	}
}
