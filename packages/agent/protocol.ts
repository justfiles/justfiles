import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { Route } from '@justfiles/app/capabilities/notify'
import type { SessionEntry } from './session.manager.ts'
import type { ActiveTurn, SessionEvent, StartTurnResult, TurnStatus } from './session.ts'

export type AgentRequest = { agentId?: string } & (
	| { type: 'prompt'; text: string }
	| { type: 'abort'; turnId: string }
	| { type: 'snapshot' }
)

export type AgentPromptResult =
	| { type: 'prompt_result'; accepted: true; turn: ActiveTurn }
	| { type: 'prompt_result'; accepted: false; activeTurn: ActiveTurn }

export type AgentFrame<T = SessionEntry> = { agentId?: string } & (
	| AgentPromptResult
	| { type: 'turn_started'; turn: ActiveTurn }
	| {
			type: 'turn_finished'
			turnId: string
			status: TurnStatus
			transcript: readonly T[]
			error?: { message: string; route?: Route }
	  }
	| { type: 'snapshot'; transcript: readonly T[]; activeTurn: ActiveTurn | null }
	| { type: 'event'; turnId: string; event: AgentEvent }
)

export type RemoteAgentState =
	| { phase: 'idle'; activeTurn: null }
	| { phase: 'submitting'; activeTurn: null }
	| { phase: 'active'; activeTurn: ActiveTurn }

export function applyAgentFrame<T>(
	state: RemoteAgentState,
	frame: AgentFrame<T>
): RemoteAgentState {
	switch (frame.type) {
		case 'turn_started':
			return { phase: 'active', activeTurn: frame.turn }
		case 'prompt_result': {
			const activeTurn = frame.accepted ? frame.turn : frame.activeTurn
			return activeTurn ? { phase: 'active', activeTurn } : { phase: 'idle', activeTurn: null }
		}
		case 'snapshot':
			return frame.activeTurn
				? { phase: 'active', activeTurn: frame.activeTurn }
				: { phase: 'idle', activeTurn: null }
		case 'turn_finished':
			// Keep object identity for a stale finish so clients can drop its transcript too.
			return state.activeTurn?.id === frame.turnId ? { phase: 'idle', activeTurn: null } : state
		case 'event':
			return state
	}
}

export function promptResult(result: StartTurnResult): AgentPromptResult {
	return result.accepted
		? { type: 'prompt_result', accepted: true, turn: result.turn }
		: { type: 'prompt_result', accepted: false, activeTurn: result.activeTurn }
}

export function sessionEventFrame(event: SessionEvent): AgentFrame
export function sessionEventFrame<T>(
	event: SessionEvent,
	mapEntries: (entries: readonly SessionEntry[]) => readonly T[]
): AgentFrame<T>
export function sessionEventFrame<T>(
	event: SessionEvent,
	mapEntries?: (entries: readonly SessionEntry[]) => readonly T[]
): AgentFrame<T> {
	const transcript = (entries: readonly SessionEntry[]): readonly T[] =>
		mapEntries ? mapEntries(entries) : (entries as readonly T[])

	switch (event.type) {
		case 'turn_started':
			return event
		case 'turn_finished':
			return {
				type: event.type,
				turnId: event.turnId,
				status: event.status,
				transcript: transcript(event.entries),
				...(event.error ? { error: event.error } : {})
			}
		case 'snapshot':
			return {
				type: event.type,
				transcript: transcript(event.snapshot.entries),
				activeTurn: event.snapshot.activeTurn
			}
	}
}
