// Minimal contract for the core logic of a stateful app or game with one or
// more participants. An Engine is pure: a reducer with optional projection,
// permissions, action discovery, and per-action schemas.
//
// Progressive disclosure:
//   simplest        { initial, step }
//   + actor views   + view(state, actor)             // GUI for humans, data for agents
//   + permissions   + allows(state, actor, action)   // roles, turn order, etc.
//   + discovery     + actions(state, actor)          // enumerate legal moves
//   + schemas       + actionSchemas                  // typed agent tools + validation

import type { TSchema } from '@sinclair/typebox'

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

	// Optional payload schemas keyed by action type. When present, the runtime
	// generates one typed agent tool per key (e.g. card_deal, card_guess) and
	// validates payloads at the boundary. When absent, a single generic
	// dispatch tool is generated.
	actionSchemas?: Record<string, TSchema>
}
