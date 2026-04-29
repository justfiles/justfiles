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
