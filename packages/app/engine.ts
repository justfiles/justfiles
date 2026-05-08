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
import type { CapabilityInstance, CapsFromInstances } from './capabilities/core.js'
import type { InvokeConfig, Task, TaskContext, TasksRecord } from './tasks.js'

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
	capabilities?: ReadonlyArray<CapabilityInstance>
	view?(snapshot: Snapshot<TState, TContext>, actor: TActor): V
}

/**
 * `task` factory handed to `withTasks(({ task }) => …)`. Closures over the
 * builder's bound `Caps` so `ctx.capabilities` is typed against declared
 * capabilities, with no type-level access to capabilities the app didn't
 * declare.
 */
export type TaskFactory<Caps> = <Input = unknown, Output = unknown>(
	handler: (ctx: TaskContext<Input, string, unknown, Caps>) => Promise<Output>
) => Task<Input, Output>

/**
 * Empty-capabilities default for engines that skip `withCapabilities`. Any
 * property access on `EmptyCaps` is a type error so handler authors can't
 * silently call into capabilities they didn't declare.
 */
// biome-ignore lint/complexity/noBannedTypes: empty object type is exactly the right shape here
export type EmptyCaps = {}

/**
 * Common terminal step for every builder phase. Once `Tasks` is bound,
 * `.build(...)` types the state literal against it.
 */
export interface BuildStep<Tasks extends TasksRecord> {
	build<
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
 * After `engine()`. Caps and Tasks both default to empty, so apps that
 * `.build(...)` immediately keep working.
 */
export interface EngineBuilder<Caps, Tasks extends TasksRecord> extends BuildStep<Tasks> {
	withCapabilities<const C extends readonly CapabilityInstance[]>(
		caps: C
	): CapsBuilder<CapsFromInstances<C>>
	withTasks<T extends TasksRecord>(factory: (api: { task: TaskFactory<Caps> }) => T): BuildStep<T>
}

/**
 * After `withCapabilities(...)`. `withCapabilities` is no longer offered:
 * binding tasks closes over the current Caps, so re-binding caps later
 * would silently leave already-typed handlers stale.
 */
export interface CapsBuilder<Caps> extends BuildStep<Record<string, never>> {
	withTasks<T extends TasksRecord>(factory: (api: { task: TaskFactory<Caps> }) => T): BuildStep<T>
}

/**
 * Start a new engine builder. With no `withCapabilities`/`withTasks` calls,
 * `Caps` and `Tasks` default to empty records — `ctx.capabilities` is `{}`
 * and `invoke.src` cannot reference any task name.
 */
export function engine(): EngineBuilder<EmptyCaps, Record<string, never>> {
	let capabilities: ReadonlyArray<CapabilityInstance> | undefined
	let tasks: TasksRecord | undefined

	const taskFactory = <I, O>(
		handler: (ctx: TaskContext<I, string, unknown, unknown>) => Promise<O>
	): Task<I, O> => ({ handler })

	const builder = {
		withCapabilities(caps: ReadonlyArray<CapabilityInstance>) {
			capabilities = caps
			return builder
		},
		// biome-ignore lint/suspicious/noExplicitAny: builder erases generics; public signature is exact
		withTasks(factory: any) {
			// biome-ignore lint/suspicious/noExplicitAny: same — generics erased internally
			tasks = factory({ task: taskFactory as any })
			return builder
		},
		// biome-ignore lint/suspicious/noExplicitAny: same
		build(literal: any): any {
			return {
				initial: literal.initial,
				context: literal.context,
				states: literal.states,
				...(literal.view ? { view: literal.view } : {}),
				...(tasks ? { tasks } : {}),
				...(capabilities ? { capabilities } : {})
			}
		}
		// biome-ignore lint/suspicious/noExplicitAny: builder is internally untyped
	} as any
	return builder
}
