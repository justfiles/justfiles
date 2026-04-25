import type { Action, Engine } from './engine'
// A stateful, mutable running instance of an Engine.
// The system (orchestrator) observes transitions via subscribe; actors themselves
// are passive — they dispatch in and are shown view() projections by the system.

export type Transition<S, A extends Action, TActor> = {
	prev: S
	next: S
	action: A
	actor: TActor
}

type DispatchResult<S> = { ok: true; state: S } | { ok: false; error: 'forbidden' }

export interface Session<S, A extends Action, TActor, V> {
	state(): S
	view(actor: TActor): V
	dispatch(actor: TActor, action: A): DispatchResult<S>
	subscribe(listener: (t: Transition<S, A, TActor>) => void): () => void
}

export function session<S, A extends Action, TActor, V>(
	engine: Engine<S, A, TActor, V>,
	initial?: S
): Session<S, A, TActor, V> {
	let state = initial ?? engine.initial
	const listeners = new Set<(t: Transition<S, A, TActor>) => void>()

	return {
		state: () => state,
		view: (actor) => (engine.view ? engine.view(state, actor) : (state as unknown as V)),
		dispatch(actor, action) {
			if (engine.allows && !engine.allows(state, actor, action)) {
				return { ok: false, error: 'forbidden' }
			}
			const prev = state
			state = engine.step(state, action, actor)
			for (const l of listeners) l({ prev, next: state, action, actor })
			return { ok: true, state }
		},
		subscribe(listener) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		}
	}
}
