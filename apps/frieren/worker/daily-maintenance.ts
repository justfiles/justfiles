import { sweepTrash } from '@justfiles/app'
import type { Volume } from '@justfiles/fs'
import type { Storage } from '@justfiles/fs/storage'

export async function runDailyMaintenance(storage: Storage, volume: Volume): Promise<void> {
	await sweepTrash(volume).catch(() => {})
	await storage.caps?.content?.gcUnreferenced().catch(() => {})
}
