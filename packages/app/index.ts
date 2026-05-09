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
export {
	APP_PERMISSIONS,
	type AppPermission,
	FORMAT_VERSION,
	type Manifest,
	ManifestSchema,
	PermissionSchema
} from './format.js'
export {
	type ActionRequest,
	type ActionResult,
	APP_RPC_ERROR,
	APP_RPC_PERMISSION,
	type AppCapabilities,
	type AppCapabilityMap,
	type AppRpcError,
	type AppRpcMethod,
	type AppRpcParams,
	type AppRpcRegistry,
	type AppRpcRequest,
	type AppRpcResponse,
	type AppRpcResult,
	type ClientRequest,
	type ReadyRequest,
	type ReadyResult,
	type RequestId,
	type Response as RpcResponse,
	type ServerMessage,
	type StateNotification
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
	type TaskMeta,
	type TasksRecord,
	task
} from './tasks.js'
