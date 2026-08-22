import type { ReleaseManifest } from '../protocol'
import { appAccess } from './capability'
import type { Database } from './db'
import { readGrant } from './grant'
import { readSession } from './session'

export async function approvedAppSession(
	database: Database,
	sessionId: string,
	app: ReleaseManifest
): Promise<{
	userId: string
	requestNonce: string
	resources: string[]
} | null> {
	const session = await readSession(database, sessionId, 'app')
	if (!session || session.appId !== app.id || !session.requestNonce) return null

	try {
		const access = await appAccess(app.id, app.capabilities)
		const grant = await readGrant(database, session.userId, app.id)
		if (!grant || grant.capabilityHash !== access.hash) return null
		return {
			userId: session.userId,
			requestNonce: session.requestNonce,
			resources: grant.resources
		}
	} catch {
		return null
	}
}
