// App-authored async tasks invoked from state machine entries. Tasks are
// declared once on the engine and referenced by name from `invoke.src` on a
// state. The pure runtime never executes them — that's the runner's job.
//
// See engine.ts for the InvokeDef shape that wires tasks into states, and
// runner.ts for lifecycle (start, abort, stale-result discard).

import { Type } from 'typebox'
import type { Action, Actor, Snapshot } from './engine.js'

/**
 * Stable serializable error shape passed to `invoke.onError`. v1 maps thrown
 * errors to `TASK_FAILED`; #59 will preserve broker capability codes.
 *
 * `TaskErrorSchema` is the typebox shape of this type — apps reusing it on a
 * system-actor transition (e.g. `briefing_failed`) can `schema:
 * TaskErrorSchema` instead of re-declaring it.
 */
export const TaskErrorSchema = Type.Object({
	code: Type.Union([
		Type.Literal('TASK_FAILED'),
		Type.Literal('TASK_ABORTED'),
		Type.Literal('CAPABILITY_DENIED'),
		Type.Literal('CAPABILITY_FAILED')
	]),
	message: Type.String(),
	capability: Type.Optional(Type.String()),
	method: Type.Optional(Type.String())
})

export type TaskError = {
	code: 'TASK_FAILED' | 'TASK_ABORTED' | 'CAPABILITY_DENIED' | 'CAPABILITY_FAILED'
	message: string
	// Populated only for CAPABILITY_* codes so `onError` can branch on which
	// capability/method failed rather than string-matching `message`.
	capability?: string
	method?: string
}

/**
 * Runtime context handed to a task handler. `Caps` is derived from the
 * engine's `withCapabilities([...])` declaration; apps with no capabilities
 * see `capabilities: {}`. The host wires the actual binding (Cloudflare
 * `APP_BRIDGE` etc.) into `capabilities` via the runner's `host()` factory.
 */
export type TaskContext<
	Input = unknown,
	TState extends string = string,
	TContext = unknown,
	Caps = Record<string, never>
> = {
	input: Input
	snapshot: Snapshot<TState, TContext>
	signal: AbortSignal
	capabilities: Caps
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
 * one task and gates `input`/`onDone` types. `Actions` is the engine's typed
 * action union — bound by `setup()` so `onDone`/`onError` returns must be a
 * declared transition's action.
 *
 * Per-task `uses: [...]` capability scope subsets are deferred (see #64).
 * Per-app grants are sufficient for v1; revisit when an app declares 4+
 * capabilities or 5+ tasks, or a security review flags per-app as too coarse.
 */
export type InvokeDef<
	Tasks extends TasksRecord,
	TState extends string,
	TContext,
	Actions extends Action = Action,
	K extends keyof Tasks & string = keyof Tasks & string
> = {
	src: K
	id?: string
	reenter?: boolean
	input?: (args: InvokeInputArgs<TState, TContext>) => InputOf<Tasks[K]>
	onDone?: (args: InvokeOnDoneArgs<TContext, OutputOf<Tasks[K]>>) => Actions | null
	onError?: (args: InvokeOnErrorArgs<TContext>) => Actions | null
}

export type InvokeConfig<
	Tasks extends TasksRecord,
	TState extends string,
	TContext,
	Actions extends Action = Action
> =
	| InvokeDef<Tasks, TState, TContext, Actions>
	| ReadonlyArray<InvokeDef<Tasks, TState, TContext, Actions>>

/** System actor used for task result actions. */
export const SYSTEM_ACTOR: Actor = { id: 'system', kind: 'system' }

/**
 * Metadata handed to the runner's `host()` factory at the start of each
 * invoke. Lets the host (typically a capability broker) tag provider-side
 * audit logs with the originating task run.
 */
export type TaskMeta = {
	taskId: string
	runId: string
	state: string
}
