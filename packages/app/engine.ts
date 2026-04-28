// Minimal contract for the core logic of a stateful app or game with one or
// more participants. An Engine is pure: a reducer with optional projection,
// permissions, action discovery, and per-action schemas.
//
// Progressive disclosure:
//   simplest        { initial, step }
//   + actor views   + view(state, actor)             // GUI for humans, data for agents
//   + permissions   + allows(state, actor, action)   // roles, turn order, etc.
//   + schemas       + actions                        // typed agent tools + validation
//   + discovery     + availableActions(state, actor) // enumerate legal moves

import type Type from 'typebox'

export type Action<T extends string = string, P = unknown> = {
	type: T
	payload: P
}

export type ActionDef<S extends Type.TSchema = Type.TSchema> = {
	schema: S
	description?: string
}

export type ActionDefs = Record<string, ActionDef>

export type ActionFromDefs<D extends ActionDefs> = {
	[K in keyof D & string]: Action<K, Type.Static<D[K]['schema']>>
}[keyof D & string]

export type Actor = {
	id: string
	kind?: 'human' | 'agent' | 'system'
}

export interface Engine<S, D extends ActionDefs, TActor = Actor, V = S> {
	// Pure idle state. Randomness / seeds / levels flow in through a setup action
	// (see card game's 'deal'), not through this initial value.
	initial: S
	actions: D
	step(state: S, action: ActionFromDefs<D>, actor: TActor): S
	view?(state: S, actor: TActor): V
	allows?(state: S, actor: TActor, action: ActionFromDefs<D>): boolean
	availableActions?(state: S, actor: TActor): readonly ActionFromDefs<D>[]
}

/**
 * Define an Engine with full type inference. Pass the engine object literal
 * and `S`, `D`, `TActor`, `V` are inferred — `step`/`allows`/`availableActions`
 * get correctly-typed `action` parameters derived from `actions`.
 */
export function define<S, D extends ActionDefs, TActor = Actor, V = S>(
	engine: Engine<S, D, TActor, V>
): Engine<S, D, TActor, V> {
	return engine
}
