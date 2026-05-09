// Frame types for the FE↔BE bridge. Plain JSON-RPC. Both transports
// (postMessage in frieren prod, WebSocket in dev) carry these verbatim.

import type { Action } from './engine.js'
import type { DispatchResult } from './runtime.js'

export type RequestId = string

export type ReadyRequest = { jsonrpc: '2.0'; id: RequestId; method: 'app.ready'; params: object }
export type ActionRequest = {
	jsonrpc: '2.0'
	id: RequestId
	method: 'app.action'
	params: { action: Action }
}
export type ClientRequest = ReadyRequest | ActionRequest

export type ReadyResult = { state: unknown }
export type ActionResult = DispatchResult<unknown, unknown>

export type Response = {
	jsonrpc: '2.0'
	id: RequestId
	result?: ReadyResult | ActionResult
	error?: { message: string }
}

export type StateNotification = {
	jsonrpc: '2.0'
	method: 'app.state'
	params: { state: unknown }
}

export type PrintNotification = {
	jsonrpc: '2.0'
	method: 'app.print'
	params: object
}

export type ServerMessage = Response | StateNotification | PrintNotification

// ── Client-only app RPC ─────────────────────────────────────────────────
//
// Single source of truth for the JSON-RPC surface client-only apps reach
// through the injected `window.app` SDK. Adding a method here updates
// SDK author types, the host dispatcher signature, and the worker
// handler map in one place. Bytes ride the wire as base64 strings.

export type AppRpcRegistry = {
	'app.volume.readText': { params: { path: string }; result: { text: string } }
	'app.volume.writeText': { params: { path: string; text: string }; result: null }
	'app.volume.readFile': { params: { path: string }; result: { bytes: string } }
	'app.volume.writeFile': { params: { path: string; bytes: string }; result: null }
}

export type AppRpcMethod = keyof AppRpcRegistry
export type AppRpcParams<M extends AppRpcMethod> = AppRpcRegistry[M]['params']
export type AppRpcResult<M extends AppRpcMethod> = AppRpcRegistry[M]['result']

export type AppRpcRequest = {
	[M in AppRpcMethod]: { jsonrpc: '2.0'; id: RequestId; method: M; params: AppRpcParams<M> }
}[AppRpcMethod]

export type AppRpcError = { code: number; message: string }

export type AppRpcResponse = {
	jsonrpc: '2.0'
	id: RequestId
	result?: unknown
	error?: AppRpcError
}

// Stable error shapes so app authors can branch on `err.code`.
export const APP_RPC_ERROR = {
	notFound: { code: -32001, message: 'not_found' },
	invalidPath: { code: -32002, message: 'invalid_path' },
	invalidPayload: { code: -32003, message: 'invalid_payload' },
	noActiveApp: { code: -32004, message: 'no_active_app' },
	methodNotFound: { code: -32601, message: 'method_not_found' },
	internal: { code: -32000, message: 'internal_error' }
} as const
