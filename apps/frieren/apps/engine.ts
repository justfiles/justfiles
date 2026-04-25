// Minimal contract for the core logic of a stateful app or game with one or
// more participants. An Engine is pure: a reducer with optional projection,
// permissions, and action discovery. Everything else (tools, views, metadata)
// lives on the App wrapper — see ./app.ts.
//
// Progressive disclosure:
//   simplest        { initial, step }
//   + actor views   + view(state, actor)         // GUI for humans, data for agents
//   + permissions   + allows(state, actor, action) // roles, turn order, etc.
//   + discovery     + actions(state, actor)      // enumerate legal moves for agents

export type Action<T extends string = string, P = unknown> = {
	type: T
	payload: P
}

export type Actor = {
	id: string
	kind?: 'human' | 'agent' | 'system'
}

export interface Engine<S, A extends Action = Action, TActor = Actor, V = S> {
	// Pure idle state. Randomness / seeds / levels flow in through a setup action
	// (see card game's 'deal'), not through this initial value.
	initial: S
	step(state: S, action: A, actor: TActor): S

	view?(state: S, actor: TActor): V
	allows?(state: S, actor: TActor, action: A): boolean
	actions?(state: S, actor: TActor): readonly A[]
}
