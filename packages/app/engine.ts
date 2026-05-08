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
	Tasks extends TasksRecord = TasksRecord,
	Actions extends Action = Action
> = {
	on?: Record<string, TransitionDef<Type.TSchema, TState, TContext, TActor>>
	invoke?: InvokeConfig<Tasks, TState, TContext, Actions>
}

export type StateDefs<
	TState extends string,
	TContext,
	TActor extends Actor,
	Tasks extends TasksRecord = TasksRecord,
	Actions extends Action = Action
> = Record<TState, StateDef<TState, TContext, TActor, Tasks, Actions>>

// Skip states without `on` so the union doesn't collapse to `never` when any
// state has no transitions (the optional-`on?` form would distribute into
// `undefined` for those, killing the resulting key set).
type TransitionsOf<States> = {
	[K in keyof States]: States[K] extends { on: infer T } ? T : never
}[keyof States]

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
 * Engine builder returned by `setup()`. The two-step setup-then-engine flow
 * mirrors XState v5: `setup()` binds type-determining inputs (tasks) up
 * front, then `.engine()` checks the state literal with those types already
 * concrete. This breaks the recursion that prevents typing `invoke.onDone`'s
 * return as `ActionFromStates<States>` in a single-call API.
 */
export interface EngineBuilder<Tasks extends TasksRecord> {
	engine<
		TState extends string,
		TContext,
		States extends StateDefs<TState, TContext, TActor, Tasks, ActionFromStates<States>>,
		TActor extends Actor = Actor,
		V = Snapshot<TState, TContext>
	>(config: {
		initial: TState
		context: TContext
		states: States
		view?(snapshot: Snapshot<TState, TContext>, actor: TActor): V
	}): Engine<TState, TContext, States, TActor, V, Tasks>
}

/**
 * Bind tasks (and any future setup-time types), then call `.engine(...)` to
 * declare the state machine. Without `tasks`, `setup()` is the no-op entry
 * point — equivalent to a defaulted-Tasks engine.
 */
export function setup<Tasks extends TasksRecord = TasksRecord>(
	config: { tasks?: Tasks } = {}
): EngineBuilder<Tasks> {
	return {
		// biome-ignore lint/suspicious/noExplicitAny: builder erases generics internally; the public signature is exact
		engine(literal: any): any {
			return {
				initial: literal.initial,
				context: literal.context,
				states: literal.states,
				...(literal.view ? { view: literal.view } : {}),
				...(config.tasks ? { tasks: config.tasks } : {})
			}
		}
	}
}
