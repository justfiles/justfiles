// Public surface for app authors and host integrators. Pure types and
// helpers — no transport, no persistence. Use `@justfiles/app/server` for
// the Bun dev harness, `@justfiles/app/client` for the browser bridge.

export { type AnyApp, type App, define as defineApp, type Transition } from './app.js'
export {
	type Action,
	type ActionDef,
	type ActionDefs,
	type ActionFromDefs,
	type Actor,
	define as defineEngine,
	type Engine
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
	availableActions,
	briefing,
	type DispatchErr,
	type DispatchOk,
	type DispatchResult,
	dispatch,
	done,
	type ToolDescriptor,
	tools,
	view
} from './runtime.js'
