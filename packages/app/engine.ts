// Minimal contract for the core logic of a stateful app or game with one or
// more participants. An Engine is pure: a state machine with optional
// projection, actor-gated transitions, guards, and per-action schemas.
//
// Progressive disclosure:
//   simplest        { initial, context, states }
//   + context edits + transition.actions(args)
//   + finite modes  + transition.target
//   + actor gates   + transition.actor / transition.guard
//   + actor views   + view(snapshot, actor) // GUI for humans, data for agents

import type Type from 'typebox'
import type { InvokeConfig, TasksRecord } from './tasks.js'

export type Action<T extends string = string, P = unknown> = {
	type: T
	payload: P
}

export type Actor = {
	id: string
	kind?: string
	role?: string
}

export type Snapshot<TState extends string = string, TContext = unknown> = {
	state: TState
	context: TContext
}

export type TransitionArgs<
	TState extends string,
	TContext,
	TAction extends Action,
	TActor extends Actor
> = {
	snapshot: Snapshot<TState, TContext>
	context: TContext
	action: TAction
	actor: TActor
}

export type Transition<TState extends string, TContext, A, TActor> = {
	prev: Snapshot<TState, TContext>
	next: Snapshot<TState, TContext>
	action: A
	actor: TActor
}

export type ActorGate<
	TState extends string = string,
	TContext = unknown,
	TAction extends Action = Action,
	TActor extends Actor = Actor
> =
	| string
	| readonly string[]
	| ((args: TransitionArgs<TState, TContext, TAction, TActor>) => boolean)

export type TransitionDef<
	S extends Type.TSchema = Type.TSchema,
	TState extends string = string,
	TContext = unknown,
	TActor extends Actor = Actor,
	TType extends string = string
> = {
	schema: S
	description?: string
	target?:
		| TState
		| ((args: TransitionArgs<TState, TContext, Action<TType, Type.Static<S>>, TActor>) => TState)
	actor?: ActorGate<TState, TContext, Action<TType, Type.Static<S>>, TActor>
	guard?(args: TransitionArgs<TState, TContext, Action<TType, Type.Static<S>>, TActor>): boolean
	actions?(args: TransitionArgs<TState, TContext, Action<TType, Type.Static<S>>, TActor>): TContext
	narrate?(
		transition: Transition<TState, TContext, Action<TType, Type.Static<S>>, TActor>,
		view: unknown
	): string | null
}

export type StateDef<
	TState extends string,
	TContext,
	TActor extends Actor,
	Tasks extends TasksRecord = TasksRecord
> = {
	on?: Record<string, TransitionDef<Type.TSchema, TState, TContext, TActor>>
	invoke?: InvokeConfig<Tasks, TState, TContext>
}

export type StateDefs<
	TState extends string,
	TContext,
	TActor extends Actor,
	Tasks extends TasksRecord = TasksRecord
> = Record<TState, StateDef<TState, TContext, TActor, Tasks>>

type TransitionsOf<States> = States[keyof States & string] extends { on?: infer T } ? T : never

export type ActionFromStates<States> = {
	[K in keyof TransitionsOf<States> & string]: TransitionsOf<States>[K] extends TransitionDef<
		infer S,
		string,
		unknown,
		Actor,
		string
	>
		? Action<K, Type.Static<S>>
		: never
}[keyof TransitionsOf<States> & string]

export interface Engine<
	TState extends string,
	TContext,
	States extends StateDefs<TState, TContext, TActor, Tasks>,
	TActor extends Actor = Actor,
	V = Snapshot<TState, TContext>,
	Tasks extends TasksRecord = TasksRecord
> {
	initial: TState
	context: TContext
	states: States
	tasks?: Tasks
	view?(snapshot: Snapshot<TState, TContext>, actor: TActor): V
}

/**
 * Define an Engine with full type inference. Pass the engine object literal
 * and `TState`, `TContext`, `States`, `TActor`, `V`, `Tasks` are inferred.
 */
export function define<
	TState extends string,
	TContext,
	TActor extends Actor = Actor,
	Tasks extends TasksRecord = TasksRecord,
	States extends StateDefs<TState, TContext, TActor, Tasks> = StateDefs<
		TState,
		TContext,
		TActor,
		Tasks
	>,
	V = Snapshot<TState, TContext>
>(
	engine: Engine<TState, TContext, States, TActor, V, Tasks>
): Engine<TState, TContext, States, TActor, V, Tasks> {
	return engine
}
