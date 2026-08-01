import { sweepTrash } from '@justfiles/app'
import type { Volume } from '@justfiles/fs'
import type { Storage } from '@justfiles/fs/storage'

export async function runDailyMaintenance(storage: Storage, volume: Volume): Promise<void> {
	await sweepTrash(volume).catch(() => {})
	await storage.caps?.content?.gcUnreferenced().catch(() => {})
}

// NO AVATAR SWEEP. Derived faces live in `<avatar>/.gen/<hash of resting>/`, so replacing an
// avatar's resting file orphans one DIRECTORY — and the generator takes the siblings out
// before it writes the current one (src/agent/faces.ts). Stale art is collected by the next
// generation instead of by a scheduled job, which is what the authored/derived split buys:
// worst case one orphan directory sits until the next expression tag, against a daily task
// and a filename grammar we no longer have to parse. Installed avatars are NEVER pruned —
// a pack, or the user's own photo, is their property.
