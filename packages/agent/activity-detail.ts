import type { Volume } from '@justfiles/fs'
import { file } from './file.ts'
import * as paths from './paths.ts'
import { ActivityDetailSchema, type SessionEntry } from './session.manager.ts'
import { type ActivityDetailResult, legacyActivityDetail } from './transcript.ts'

export async function readActivityDetail(
	volume: Volume,
	agentId: string,
	sessionId: string,
	history: readonly SessionEntry[],
	detailId: string
): Promise<ActivityDetailResult> {
	const legacy = legacyActivityDetail(history, detailId)
	if (legacy) return { status: 'available', detail: legacy }
	if (!history.some((entry) => entry.type === 'activity' && entry.detailId === detailId))
		return { status: 'expired' }
	try {
		const detail = await file(volume, paths.activityDetail(agentId, sessionId, detailId)).json(
			ActivityDetailSchema
		)
		return detail ? { status: 'available', detail } : { status: 'expired' }
	} catch {
		return { status: 'expired' }
	}
}
