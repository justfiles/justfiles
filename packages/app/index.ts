// Public surface for app authors and host integrators. Pure types and
// helpers — no transport, no persistence. Use `@justfiles/app/server` for
// the Bun dev harness, `@justfiles/app/client` for the browser bridge.

export { type AnyApp, type App, define as defineApp, type Transition } from './app.js'
export {
	type Action,
	type ActionFromStates,
	type Actor,
	type ActorGate,
	type BuildStep,
	type CapsBuilder,
	type EmptyCaps,
	type Engine,
	type EngineBuilder,
	engine,
	type Snapshot,
	type StateDef,
	type StateDefs,
	type TaskFactory,
	type TransitionArgs,
	type TransitionDef
} from './engine.js'
export type {
	ActionRequest,
	ActionResult,
	ClientRequest,
	ReadyRequest,
	ReadyResult,
	RequestId,
	Response as RpcResponse,
	ServerMessage,
	StateNotification
} from './protocol.js'
export {
	allows,
	availableActions,
	briefing,
	type DispatchErr,
	type DispatchOk,
	type DispatchResult,
	dispatch,
	done,
	initial,
	type ToolDescriptor,
	tools,
	view
} from './runtime.js'
export {
	type AnyTask,
	defineTasks,
	type InputOf,
	type InvokeConfig,
	type InvokeDef,
	type InvokeInputArgs,
	type InvokeOnDoneArgs,
	type InvokeOnErrorArgs,
	type OutputOf,
	SYSTEM_ACTOR,
	type Task,
	type TaskContext,
	type TaskError,
	TaskErrorSchema,
	type TasksRecord,
	task
} from './tasks.js'
