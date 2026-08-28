import type { SessionSnapshot, SessionStatus, SessionUpdate, StartTurnResult } from './session.ts'

export {
	type ActivityDetailResult,
	sessionEntriesToTranscriptItems,
	type TranscriptActivity,
	type TranscriptImage,
	type TranscriptItem,
	type TranscriptStatus
} from './transcript.ts'

import {
	type ActivityDetailResult,
	sessionEntriesToTranscriptItems,
	type TranscriptItem
} from './transcript.ts'

export type SessionClientMessage =
	| { type: 'prompt'; text: string }
	| { type: 'abort' }
	| { type: 'snapshot' }
	| { type: 'activity_detail'; requestId: string; detailId: string }

export type SessionServerMessage =
	| { type: 'snapshot'; history: readonly TranscriptItem[]; status: SessionStatus }
	| { type: 'item'; item: TranscriptItem }
	| Extract<SessionUpdate, { type: 'status' }>
	| { type: 'accepted' }
	| { type: 'rejected'; reason: 'busy' }
	| {
			type: 'activity_detail'
			requestId: string
			result: ActivityDetailResult
	  }

type PromptReply = Extract<SessionServerMessage, { type: 'accepted' | 'rejected' }>

export function promptReply(result: StartTurnResult): PromptReply {
	return result.accepted ? { type: 'accepted' } : { type: 'rejected', reason: 'busy' }
}

export function snapshotMessage(
	snapshot: SessionSnapshot,
	mapEntries: (
		entries: SessionSnapshot['history']
	) => readonly TranscriptItem[] = sessionEntriesToTranscriptItems
): SessionServerMessage {
	return {
		type: 'snapshot',
		history: mapEntries(snapshot.history),
		status: snapshot.status
	}
}

export function updateMessages(
	update: SessionUpdate,
	mapEntries: (
		entries: SessionSnapshot['history']
	) => readonly TranscriptItem[] = sessionEntriesToTranscriptItems
): readonly SessionServerMessage[] {
	switch (update.type) {
		case 'items':
			return mapEntries(update.items).map((item) => ({ type: 'item', item }))
		case 'snapshot':
			return [snapshotMessage(update.snapshot, mapEntries)]
		case 'status':
			return [update]
	}
}
