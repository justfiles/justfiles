import type { Database } from './db'
import { hashSecret, randomSecret } from './secret'

const SESSION_LIFE_MS = 30 * 24 * 60 * 60 * 1000
const TICKET_LIFE_MS = 5 * 60 * 1000

type SessionKind = 'root' | 'app' | 'ticket'

type NewSession =
	| { kind: 'root'; userId: string }
	| { kind: 'app'; userId: string; appId: string }
	| {
			kind: 'ticket'
			userId: string
			appId: string
			origin: string
			capabilityHash: string
	  }

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
		`INSERT INTO sessions
			(id_hash, kind, user_id, app_id, request_nonce, expires_at,
			 ticket_origin, capability_hash)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		await hashSecret(id),
		input.kind,
		input.userId,
		'appId' in input ? input.appId : null,
		requestNonce,
		expiresAt,
		input.kind === 'ticket' ? input.origin : null,
		input.kind === 'ticket' ? input.capabilityHash : null
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

/** The D1 batch makes the ticket use and app session creation one operation. */
export async function exchangeTicket(
	database: Database,
	id: string,
	appId: string,
	origin: string,
	capabilityHash: string,
	now = Date.now()
): Promise<{ id: string; requestNonce: string; expiresAt: number } | null> {
	const sessionId = randomSecret()
	const requestNonce = randomSecret()
	const expiresAt = now + SESSION_LIFE_MS
	const ticketHash = await hashSecret(id)
	const [created, consumed] = await database.batch([
		{
			sql: `INSERT INTO sessions
				(id_hash, kind, user_id, app_id, request_nonce, expires_at)
			 SELECT ?, 'app', ticket.user_id, ticket.app_id, ?, ?
			 FROM sessions AS ticket
			 JOIN app_grants AS grant
				ON grant.user_id = ticket.user_id AND grant.app_id = ticket.app_id
			 WHERE ticket.id_hash = ? AND ticket.kind = 'ticket'
				AND ticket.app_id = ? AND ticket.ticket_origin = ?
				AND ticket.capability_hash = ? AND ticket.expires_at > ?
				AND grant.revoked_at IS NULL AND grant.capability_hash = ?`,
			values: [
				await hashSecret(sessionId),
				requestNonce,
				expiresAt,
				ticketHash,
				appId,
				origin,
				capabilityHash,
				now,
				capabilityHash
			]
		},
		{
			sql: `DELETE FROM sessions
			 WHERE id_hash = ? AND kind = 'ticket' AND app_id = ?
				AND ticket_origin = ? AND capability_hash = ? AND expires_at > ?`,
			values: [ticketHash, appId, origin, capabilityHash, now]
		}
	])
	return created === 1 && consumed === 1 ? { id: sessionId, requestNonce, expiresAt } : null
}

const life = (kind: SessionKind): number => {
	return kind === 'ticket' ? TICKET_LIFE_MS : SESSION_LIFE_MS
}
