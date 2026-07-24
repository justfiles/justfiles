import { sweepTrash } from '@justfiles/app'
import type { Volume } from '@justfiles/fs'
import type { Storage } from '@justfiles/fs/storage'
import { BACKUP_RETENTION_MS, sweepMigrationBackups } from '../shared/migrate-app-ids.ts'

export async function runDailyMaintenance(storage: Storage, volume: Volume): Promise<void> {
	await sweepTrash(volume).catch(() => {})
	// Server-authoritative expiry of the one-off id-migration backup for synced
	// profiles (local-only profiles sweep it on client boot). Temporary — removed
	// with the migration.
	await sweepMigrationBackups(volume, { now: Date.now(), retentionMs: BACKUP_RETENTION_MS }).catch(
		() => {}
	)
	await storage.caps?.content?.gcUnreferenced().catch(() => {})
}
