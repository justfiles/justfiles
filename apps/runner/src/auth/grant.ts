import type { Database } from './db'

interface Grant {
	userId: string
	appId: string
	capabilityHash: string
	resources: string[]
}

interface GrantRow extends Omit<Grant, 'resources'> {
	resources: string
}

export async function putGrant(database: Database, grant: Grant): Promise<void> {
	await database.run(
		`INSERT INTO app_grants (user_id, app_id, capability_hash, resources, revoked_at)
		 VALUES (?, ?, ?, ?, NULL)
		 ON CONFLICT (user_id, app_id) DO UPDATE SET
			capability_hash = excluded.capability_hash,
			resources = excluded.resources,
			revoked_at = NULL`,
		grant.userId,
		grant.appId,
		grant.capabilityHash,
		JSON.stringify([...new Set(grant.resources)].sort())
	)
}

export async function readGrant(
	database: Database,
	userId: string,
	appId: string
): Promise<Grant | null> {
	const row = await database.first<GrantRow>(
		`SELECT user_id AS userId, app_id AS appId, capability_hash AS capabilityHash, resources
		 FROM app_grants WHERE user_id = ? AND app_id = ? AND revoked_at IS NULL`,
		userId,
		appId
	)
	if (!row) return null
	const resources: unknown = JSON.parse(row.resources)
	if (!Array.isArray(resources) || !resources.every((resource) => typeof resource === 'string'))
		throw new Error('grant has invalid resources')
	return { ...row, resources }
}

export async function revokeGrant(
	database: Database,
	userId: string,
	appId: string,
	now = Date.now()
): Promise<void> {
	await database.run(
		'UPDATE app_grants SET revoked_at = ? WHERE user_id = ? AND app_id = ?',
		now,
		userId,
		appId
	)
}
