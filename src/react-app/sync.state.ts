export const DEFAULT_DEBOUNCE_MS = 3_000
export const RETRY_DELAYS_MS = [5_000, 15_000, 60_000] as const

export type DocPhase = 'idle' | 'debouncing' | 'flushing' | 'retry_wait' | 'offline'

export type DocState = {
	phase: DocPhase
	retryCount: number
	lastLocalUpdateAt: number | null
	lastRemoteSyncAt: number | null
	lastErrorAt: number | null
	revision: string | null
}

export type DocEvent =
	| { type: 'SCHEDULE_FLUSH' }
	| { type: 'FLUSH_NOW' }
	| { type: 'DEBOUNCE_FIRED' }
	| { type: 'RETRY_FIRED' }
	| { type: 'ONLINE' }
	| { type: 'OFFLINE' }
	| { type: 'LOCAL_UPDATED'; at: number }
	| { type: 'REMOTE_LOADED'; at: number; revision?: string | null }
	| { type: 'LOAD_ERROR'; at: number }
	| {
			type: 'FLUSH_SUCCEEDED'
			updatedAt: number
			revision?: string | null
			hasRemaining: boolean
	  }
	| { type: 'FLUSH_SKIPPED'; hasRemaining: boolean }
	| { type: 'FLUSH_FAILED'; at: number }

export type DocEffect =
	| { type: 'START_DEBOUNCE'; delayMs: number }
	| { type: 'CANCEL_DEBOUNCE' }
	| { type: 'START_RETRY'; delayMs: number }
	| { type: 'CANCEL_RETRY' }
	| { type: 'RUN_FLUSH' }

export type TransitionResult = {
	state: DocState
	effects: DocEffect[]
}

export function createInitialDocState(isOnline: boolean): DocState {
	return {
		phase: isOnline ? 'idle' : 'offline',
		retryCount: 0,
		lastLocalUpdateAt: null,
		lastRemoteSyncAt: null,
		lastErrorAt: null,
		revision: null
	}
}

export function getRetryDelayMs(retryCount: number): number {
	return RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)]
}

export function transition(state: DocState, event: DocEvent): TransitionResult {
	switch (event.type) {
		case 'LOCAL_UPDATED':
			return {
				state: {
					...state,
					lastLocalUpdateAt: event.at
				},
				effects: []
			}

		case 'REMOTE_LOADED':
			return {
				state: {
					...state,
					lastRemoteSyncAt: event.at,
					revision: event.revision ?? null
				},
				effects: []
			}

		case 'LOAD_ERROR':
			return {
				state: {
					...state,
					lastErrorAt: event.at
				},
				effects: []
			}

		case 'OFFLINE':
			return {
				state: {
					...state,
					phase: 'offline'
				},
				effects: [{ type: 'CANCEL_DEBOUNCE' }, { type: 'CANCEL_RETRY' }]
			}

		case 'ONLINE':
			if (state.phase !== 'offline') {
				return { state, effects: [] }
			}
			return {
				state: {
					...state,
					phase: 'idle'
				},
				effects: []
			}

		case 'SCHEDULE_FLUSH':
			if (state.phase === 'offline' || state.phase === 'flushing' || state.phase === 'retry_wait') {
				return { state, effects: [] }
			}
			return {
				state: {
					...state,
					phase: 'debouncing'
				},
				effects: [{ type: 'CANCEL_DEBOUNCE' }, { type: 'START_DEBOUNCE', delayMs: DEFAULT_DEBOUNCE_MS }]
			}

		case 'FLUSH_NOW':
			if (state.phase === 'offline' || state.phase === 'flushing') {
				return { state, effects: [] }
			}
			return {
				state: {
					...state,
					phase: 'flushing'
				},
				effects: [
					{ type: 'CANCEL_DEBOUNCE' },
					{ type: 'CANCEL_RETRY' },
					{ type: 'RUN_FLUSH' }
				]
			}

		case 'DEBOUNCE_FIRED':
			if (state.phase !== 'debouncing') {
				return { state, effects: [] }
			}
			return {
				state: {
					...state,
					phase: 'flushing'
				},
				effects: [{ type: 'RUN_FLUSH' }]
			}

		case 'RETRY_FIRED':
			if (state.phase !== 'retry_wait') {
				return { state, effects: [] }
			}
			return {
				state: {
					...state,
					phase: 'flushing'
				},
				effects: [{ type: 'RUN_FLUSH' }]
			}

		case 'FLUSH_SUCCEEDED':
			if (state.phase !== 'flushing') {
				return { state, effects: [] }
			}
			if (event.hasRemaining) {
				return {
					state: {
						...state,
						phase: 'debouncing',
						retryCount: 0,
						lastRemoteSyncAt: event.updatedAt,
						revision: event.revision ?? null
					},
					effects: [{ type: 'START_DEBOUNCE', delayMs: DEFAULT_DEBOUNCE_MS }]
				}
			}
			return {
				state: {
					...state,
					phase: 'idle',
					retryCount: 0,
					lastRemoteSyncAt: event.updatedAt,
					revision: event.revision ?? null
				},
				effects: []
			}

		case 'FLUSH_SKIPPED':
			if (state.phase !== 'flushing') {
				return { state, effects: [] }
			}
			if (event.hasRemaining) {
				return {
					state: {
						...state,
						phase: 'debouncing'
					},
					effects: [{ type: 'START_DEBOUNCE', delayMs: DEFAULT_DEBOUNCE_MS }]
				}
			}
			return {
				state: {
					...state,
					phase: 'idle'
				},
				effects: []
			}

		case 'FLUSH_FAILED':
			if (state.phase !== 'flushing') {
				return { state, effects: [] }
			}
			return {
				state: {
					...state,
					phase: 'retry_wait',
					retryCount: state.retryCount + 1,
					lastErrorAt: event.at
				},
				effects: [{ type: 'START_RETRY', delayMs: getRetryDelayMs(state.retryCount) }]
			}
	}
}
