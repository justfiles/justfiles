// App-authored async tasks invoked from state machine entries. Tasks are
// declared once on the engine and referenced by name from `invoke.src` on a
// state. The pure runtime never executes them — that's the runner's job.
//
// See engine.ts for the InvokeDef shape that wires tasks into states, and
// runner.ts for lifecycle (start, abort, stale-result discard).

import type { Action, Actor, Snapshot } from './engine.js'

/**
 * Stable serializable error shape passed to `invoke.onError`. v1 maps thrown
 * errors to `TASK_FAILED`; #59 will preserve broker capability codes.
 */
export type TaskError = {
	code: 'TASK_FAILED' | 'TASK_ABORTED' | 'CAPABILITY_DENIED' | 'CAPABILITY_FAILED'
	message: string
}

/**
 * Runtime context handed to a task handler. Host-injected fields (e.g. a
 * capability bridge from #59) are merged via the `Host` parameter.
 */
export type TaskContext<
	Input = unknown,
	TState extends string = string,
	TContext = unknown,
	Host = Record<string, never>
> = Host & {
	input: Input
	snapshot: Snapshot<TState, TContext>
	signal: AbortSignal
}

/**
 * A declared async task. Carries phantom `__input`/`__output` so that
 * `invoke.src` typechecks `input` and `onDone({ output })` against the
 * selected task's signature.
 */
export interface Task<Input, Output> {
	handler: (ctx: TaskContext<Input>) => Promise<Output>
	readonly __input?: Input
	readonly __output?: Output
}

/**
 * Declare a typed task. `Input` and `Output` are inferred from the handler
 * signature when callers annotate them; otherwise pass them as type args.
 */
export function task<Input = unknown, Output = unknown>(
	handler: (ctx: TaskContext<Input>) => Promise<Output>
): Task<Input, Output> {
	return { handler }
}

// biome-ignore lint/suspicious/noExplicitAny: existential erasure for task records
export type AnyTask = Task<any, any>

export type TasksRecord = Record<string, AnyTask>

/**
 * Declare the tasks bound to an engine. Identity-typed so callers retain key
 * literal types for `invoke.src` inference.
 */
export function defineTasks<T extends TasksRecord>(tasks: T): T {
	return tasks
}

// Inferred via the phantom `__input`/`__output` fields rather than the
// handler signature: `Input` appears in a contravariant position on the
// handler, so `T extends Task<infer I, _>` would only match when `I` is the
// top type. The phantoms sidestep that.
export type InputOf<T> = T extends { __input?: infer I } ? I : never
export type OutputOf<T> = T extends { __output?: infer O } ? O : never

/** Args passed to `invoke.input(...)`. */
export type InvokeInputArgs<TState extends string, TContext> = {
	context: TContext
	snapshot: Snapshot<TState, TContext>
}

/** Args passed to `invoke.onDone(...)`. */
export type InvokeOnDoneArgs<TContext, Output> = {
	output: Output
	context: TContext
}

/** Args passed to `invoke.onError(...)`. */
export type InvokeOnErrorArgs<TContext> = {
	error: TaskError
	context: TContext
}

/**
 * Invoke configuration on a state. `Tasks` comes from the engine; `K` selects
 * one task and gates `input`/`onDone` types.
 */
export type InvokeDef<
	Tasks extends TasksRecord,
	TState extends string,
	TContext,
	K extends keyof Tasks & string = keyof Tasks & string
> = {
	src: K
	id?: string
	reenter?: boolean
	input?: (args: InvokeInputArgs<TState, TContext>) => InputOf<Tasks[K]>
	onDone?: (args: InvokeOnDoneArgs<TContext, OutputOf<Tasks[K]>>) => Action | null
	onError?: (args: InvokeOnErrorArgs<TContext>) => Action | null
}

export type InvokeConfig<Tasks extends TasksRecord, TState extends string, TContext> =
	| InvokeDef<Tasks, TState, TContext>
	| ReadonlyArray<InvokeDef<Tasks, TState, TContext>>

/** System actor used for task result actions. */
export const SYSTEM_ACTOR: Actor = { id: 'system', kind: 'system' }
