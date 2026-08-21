import type { Database } from './db'

export async function cleanExpired(database: Database, now = Date.now()): Promise<number> {
	const [flows, sessions] = await Promise.all([
		database.run('DELETE FROM oauth_flows WHERE expires_at <= ?', now),
		database.run('DELETE FROM sessions WHERE expires_at <= ?', now)
	])
	return flows + sessions
}
