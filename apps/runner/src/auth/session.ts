import type { Database } from './db'
import { hashSecret, randomSecret } from './secret'

const ROOT_LIFE_MS = 30 * 24 * 60 * 60 * 1000
const TICKET_LIFE_MS = 5 * 60 * 1000

type SessionKind = 'root' | 'app' | 'ticket'

type NewSession =
	| { kind: 'root'; userId: string }
	| { kind: 'app'; userId: string; appId: string }
	| { kind: 'ticket'; userId: string; appId: string }

interface Session {
	kind: SessionKind
	userId: string
	appId: string | null
	requestNonce: string | null
	expiresAt: number
}

export async function createSession(database: Database, input: NewSession, now = Date.now()) {
	const id = randomSecret()
	const requestNonce = input.kind === 'app' ? randomSecret() : null
	const expiresAt = now + life(input.kind)
	await database.run(
		`INSERT INTO sessions (id_hash, kind, user_id, app_id, request_nonce, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		await hashSecret(id),
		input.kind,
		input.userId,
		'appId' in input ? input.appId : null,
		requestNonce,
		expiresAt
	)
	return { id, requestNonce, expiresAt }
}

export async function readSession(
	database: Database,
	id: string,
	kind: Exclude<SessionKind, 'ticket'>,
	now = Date.now()
): Promise<Session | null> {
	return database.first<Session>(
		`SELECT kind, user_id AS userId, app_id AS appId,
			request_nonce AS requestNonce, expires_at AS expiresAt
		 FROM sessions
		 WHERE id_hash = ? AND kind = ? AND expires_at > ?`,
		await hashSecret(id),
		kind,
		now
	)
}

export async function takeTicket(
	database: Database,
	id: string,
	appId: string,
	now = Date.now()
): Promise<Session | null> {
	return database.first<Session>(
		`DELETE FROM sessions
		 WHERE id_hash = ? AND kind = 'ticket' AND app_id = ? AND expires_at > ?
		 RETURNING kind, user_id AS userId, app_id AS appId,
			request_nonce AS requestNonce, expires_at AS expiresAt`,
		await hashSecret(id),
		appId,
		now
	)
}

const life = (kind: SessionKind): number => {
	return kind === 'ticket' ? TICKET_LIFE_MS : ROOT_LIFE_MS
}
