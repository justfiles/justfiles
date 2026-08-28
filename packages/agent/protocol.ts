import type { SessionEntry } from './session.manager.ts'
import type { SessionSnapshot, SessionStatus, SessionUpdate, StartTurnResult } from './session.ts'

export type SessionClientMessage =
	| { type: 'prompt'; text: string }
	| { type: 'abort' }
	| { type: 'snapshot' }

export type SessionServerMessage<T = SessionEntry> =
	| { type: 'snapshot'; history: readonly T[]; status: SessionStatus }
	| { type: 'item'; item: T }
	| Extract<SessionUpdate, { type: 'status' }>
	| { type: 'accepted' }
	| { type: 'rejected'; reason: 'busy' }

type PromptReply = Extract<SessionServerMessage, { type: 'accepted' | 'rejected' }>

export function promptReply(result: StartTurnResult): PromptReply {
	return result.accepted ? { type: 'accepted' } : { type: 'rejected', reason: 'busy' }
}

export function snapshotMessage<T = SessionEntry>(
	snapshot: SessionSnapshot,
	mapEntries: (entries: readonly SessionEntry[]) => readonly T[] = (entries) =>
		entries as readonly T[]
): SessionServerMessage<T> {
	return {
		type: 'snapshot',
		history: mapEntries(snapshot.history),
		status: snapshot.status
	}
}

export function updateMessages<T = SessionEntry>(
	update: SessionUpdate,
	mapEntries: (entries: readonly SessionEntry[]) => readonly T[] = (entries) =>
		entries as readonly T[]
): readonly SessionServerMessage<T>[] {
	switch (update.type) {
		case 'items':
			return mapEntries(update.items).map((item) => ({ type: 'item', item }))
		case 'snapshot':
			return [snapshotMessage(update.snapshot, mapEntries)]
		case 'status':
			return [update]
	}
}
