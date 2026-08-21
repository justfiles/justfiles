import type { Database } from './db'
import { hashSecret, randomSecret } from './secret'

const FLOW_LIFE_MS = 10 * 60 * 1000

interface Flow {
	appId: string
	verifier: string
	nonce: string
}

export async function beginFlow(database: Database, appId: string, now = Date.now()) {
	const state = randomSecret()
	const browser = randomSecret()
	const verifier = randomSecret()
	const nonce = randomSecret()
	const challenge = await hashSecret(verifier)
	await database.run(
		`INSERT INTO oauth_flows
			(state_hash, pkce_verifier, oidc_nonce, browser_hash, app_id, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		await hashSecret(state),
		verifier,
		nonce,
		await hashSecret(browser),
		appId,
		now + FLOW_LIFE_MS
	)
	return { state, browser, challenge, nonce }
}

export async function takeFlow(
	database: Database,
	state: string,
	browser: string,
	now = Date.now()
): Promise<Flow | null> {
	return database.first<Flow>(
		`DELETE FROM oauth_flows
		 WHERE state_hash = ? AND browser_hash = ? AND expires_at > ?
		 RETURNING app_id AS appId, pkce_verifier AS verifier, oidc_nonce AS nonce`,
		await hashSecret(state),
		await hashSecret(browser),
		now
	)
}
