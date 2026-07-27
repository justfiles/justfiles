import {
	AGENT_DIR,
	AVATAR_PATH,
	avatarFaceHash,
	parseAvatarFaceName
} from '@justfiles/agent/defaults'
import { sweepTrash } from '@justfiles/app'
import type { Volume } from '@justfiles/fs'
import type { Storage } from '@justfiles/fs/storage'

export async function runDailyMaintenance(storage: Storage, volume: Volume): Promise<void> {
	await sweepTrash(volume).catch(() => {})
	await sweepAvatarFaces(volume).catch(() => {})
	await storage.caps?.content?.gcUnreferenced().catch(() => {})
}

// Per-expression faces carry their source avatar's hash in the name (see
// @justfiles/agent/defaults), so replacing `avatar.png` orphans the old set instead of
// overwriting it. Drop the orphans: they are regenerated on demand, and a missing one
// just falls back to the base avatar.
async function sweepAvatarFaces(volume: Volume): Promise<void> {
	if (!(await volume.exists(AGENT_DIR))) return
	const current = (await volume.exists(AVATAR_PATH))
		? await avatarFaceHash(await volume.readFile(AVATAR_PATH))
		: null
	for (const entry of await volume.readdir(AGENT_DIR)) {
		const face = parseAvatarFaceName(entry.name)
		if (!face || face.hash === current) continue
		await volume.rm(`${AGENT_DIR}/${entry.name}`, { force: true }).catch(() => {})
	}
}
