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
	type TranscriptItem,
	type TranscriptStatus
} from './transcript.ts'

type ProjectStatus = (status: SessionStatus) => TranscriptStatus

export type SessionClientMessage =
	| { type: 'prompt'; text: string }
	| { type: 'abort' }
	| { type: 'snapshot' }
	| { type: 'activity_detail'; requestId: string; detailId: string }

export type SessionServerMessage =
	| { type: 'snapshot'; history: readonly TranscriptItem[]; status: TranscriptStatus }
	| { type: 'item'; item: TranscriptItem }
	| {
			type: 'status'
			status: TranscriptStatus
			error?: Extract<SessionUpdate, { type: 'status' }>['error']
	  }
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
	) => readonly TranscriptItem[] = sessionEntriesToTranscriptItems,
	mapStatus: ProjectStatus = projectBusyStatus
): SessionServerMessage {
	return {
		type: 'snapshot',
		history: mapEntries(snapshot.history),
		status: mapStatus(snapshot.status)
	}
}

export function updateMessages(
	update: SessionUpdate,
	mapEntries: (
		entries: SessionSnapshot['history']
	) => readonly TranscriptItem[] = sessionEntriesToTranscriptItems,
	mapStatus: ProjectStatus = projectBusyStatus
): readonly SessionServerMessage[] {
	switch (update.type) {
		case 'items':
			return mapEntries(update.items).map((item) => ({ type: 'item', item }))
		case 'snapshot':
			return [snapshotMessage(update.snapshot, mapEntries, mapStatus)]
		case 'status':
			return [{ ...update, status: mapStatus(update.status) }]
	}
}

function projectBusyStatus(status: SessionStatus): TranscriptStatus {
	return status.state === 'idle' ? status : { state: 'thinking', label: 'Working' }
}
