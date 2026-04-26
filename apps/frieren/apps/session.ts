// A stateful, mutable running instance of an Engine.
// The system (orchestrator) observes transitions via subscribe; actors themselves
// are passive — they dispatch in and are shown view() projections by the system.

import type { Action, Engine } from './engine'

export type Transition<S, A extends Action, TActor> = {
	prev: S
	next: S
	action: A
	actor: TActor
}

export type LogEntry<A extends Action> = {
	at: number
	actorId: string
	action: A
}

type DispatchResult<S> = { ok: true; state: S } | { ok: false; error: 'forbidden' }

export interface Session<S, A extends Action, TActor, V> {
	state(): S
	view(actor: TActor): V
	dispatch(actor: TActor, action: A): DispatchResult<S>
	subscribe(listener: (t: Transition<S, A, TActor>) => void): () => void
	log(): readonly LogEntry<A>[]
}

export interface SessionOptions<S, A extends Action> {
	initial?: S
	log?: readonly LogEntry<A>[]
	maxLog?: number
}

const DEFAULT_MAX_LOG = 200

export function session<S, A extends Action, TActor extends { id: string }, V>(
	engine: Engine<S, A, TActor, V>,
	options: SessionOptions<S, A> = {}
): Session<S, A, TActor, V> {
	let state = options.initial ?? engine.initial
	const listeners = new Set<(t: Transition<S, A, TActor>) => void>()
	const maxLog = options.maxLog ?? DEFAULT_MAX_LOG
	const log: LogEntry<A>[] = options.log ? [...options.log].slice(-maxLog) : []

	return {
		state: () => state,
		view: (actor) => (engine.view ? engine.view(state, actor) : (state as unknown as V)),
		dispatch(actor, action) {
			if (engine.allows && !engine.allows(state, actor, action)) {
				return { ok: false, error: 'forbidden' }
			}
			const prev = state
			state = engine.step(state, action, actor)
			log.push({ at: Date.now(), actorId: actor.id, action })
			if (log.length > maxLog) log.splice(0, log.length - maxLog)
			for (const l of listeners) l({ prev, next: state, action, actor })
			return { ok: true, state }
		},
		subscribe(listener) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		log: () => log
	}
}
