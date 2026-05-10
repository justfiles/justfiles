// Frame types for the FE↔BE bridge. Plain JSON-RPC. Both transports
// (postMessage in frieren prod, WebSocket in dev) carry these verbatim.

import type { CalendarCapability } from './capabilities/calendar/contract.js'
import type { EmailCapability } from './capabilities/email/contract.js'
import type { Action } from './engine.js'
import type { AppPermission } from './format.js'
import type { DispatchResult } from './runtime.js'

export type RequestId = string

// ── LEGACY: state-machine app bridge ────────────────────────────────────
// Everything in this section ships with `client.js` and the state-machine
// app system. Slated for removal alongside that platform — see #76.

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
	'app.capability.invoke': {
		params: { capability: string; method: string; input: unknown }
		result: { value: unknown }
	}
	'app.agent.send': { params: { text: string }; result: null }
	'app.tool.register': {
		params: { name: string; description: string; schema: Record<string, unknown> }
		result: null
	}
}

export type AppRpcMethod = keyof AppRpcRegistry
export type AppRpcParams<M extends AppRpcMethod> = AppRpcRegistry[M]['params']
export type AppRpcResult<M extends AppRpcMethod> = AppRpcRegistry[M]['result']

export type AppRpcRequest = {
	[M in AppRpcMethod]: { jsonrpc: '2.0'; id: RequestId; method: M; params: AppRpcParams<M> }
}[AppRpcMethod]

export type AppRpcError = { code: number; message: string; data?: unknown }

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
	permissionDenied: { code: -32005, message: 'permission_denied' },
	capabilityDenied: { code: -32010, message: 'capability_denied' },
	capabilityFailed: { code: -32011, message: 'capability_failed' },
	toolUnavailable: { code: -32020, message: 'tool_unavailable' },
	toolTimeout: { code: -32021, message: 'tool_timeout' },
	toolHandlerError: { code: -32022, message: 'tool_handler_error' },
	methodNotFound: { code: -32601, message: 'method_not_found' },
	internal: { code: -32000, message: 'internal_error' }
} as const

// Single source of truth for which manifest permission a method requires.
// The host gates dispatch against this map; `null` means no permission needed.
// Capability invocation isn't gated by manifest permission — the broker's
// per-scope grants (and provider account resolution) own that decision.
export const APP_RPC_PERMISSION: { [M in AppRpcMethod]: AppPermission | null } = {
	'app.volume.readText': 'volume',
	'app.volume.writeText': 'volume',
	'app.volume.readFile': 'volume',
	'app.volume.writeFile': 'volume',
	'app.capability.invoke': null,
	'app.agent.send': 'agent',
	'app.tool.register': null
}

// ── SDK surface — author-facing types ──────────────────────────────────
//
// `sdk.ts` derives its concrete API from these so the registry stays the
// only place a method's shape is declared.

export interface AppLifecycle {
	/** Register a callback that fires once when the host starts the app.
	 *  If the app has already started, the callback runs in a microtask.
	 *  Returns an unsubscribe function. */
	onStart(callback: () => void): () => void
	/** Register a callback that fires once when the host stops the app —
	 *  either because the user closed it or the iframe is reloading. Runs
	 *  best-effort: the iframe may be torn down before async work settles.
	 *  After stop the SDK clears registered tool handlers; subsequent
	 *  host invocations of those tools return `tool_unavailable`.
	 *  Returns an unsubscribe function. */
	onStop(callback: () => void): () => void
}

export interface AppVolume {
	/** Read a UTF-8 text file from app-private storage. Rejects with
	 *  `code: -32001` (not_found) when the file is missing. */
	readText(path: string): Promise<string>
	/** Write a UTF-8 text file. Parent directories are created as needed. */
	writeText(path: string, text: string): Promise<void>
	/** Read raw bytes from app-private storage. */
	readFile(path: string): Promise<Uint8Array>
	/** Write raw bytes. Parent directories are created as needed. */
	writeFile(path: string, bytes: Uint8Array): Promise<void>
}

/**
 * Author-facing typed map of host capabilities reachable from `app.capabilities`.
 *
 * Extensible by interface declaration merging — adding a future capability
 * means augmenting this map plus registering a host broker, with no transport
 * change. Runtime invocation goes through one generic
 * `app.capability.invoke` JSON-RPC method regardless of which key is called.
 *
 * ```ts
 * declare module '@justfiles/app/protocol' {
 *   interface AppCapabilityMap { reminders: RemindersCapability }
 * }
 * ```
 */
export interface AppCapabilityMap {
	email: EmailCapability
	calendar: CalendarCapability
}

export type AppCapabilities = { readonly [K in keyof AppCapabilityMap]: AppCapabilityMap[K] }

/** Registry of JSON-RPC requests the host sends to the client SDK. */
export type AppHostRpcRegistry = {
	'app.agent.describe': { params: object; result: { description: string | null } }
	'app.tool.invoke': { params: { callId: string; name: string; input: unknown }; result: unknown }
}

/** A client-side agent tool with a handler that runs in the iframe. */
export interface AppTool {
	readonly name: string
	readonly description: string
	/** JSON Schema object describing the tool's input. */
	readonly schema: Record<string, unknown>
	/** Called by the host when the agent invokes this tool. */
	readonly handler: (input: unknown) => unknown | Promise<unknown>
}

/** Registry for client-side agent tools. */
export interface AppToolRegistry {
	/** Register a tool so the host can expose it to the agent.
	 *  Returns an unregister function. The tool is removed automatically
	 *  when the app stops. */
	register(tool: AppTool): () => void
}

export interface AppAgent {
	/** Send text into the host agent flow as if the app were prompting it.
	 *  Requires the `agent` manifest permission. Resolves once the prompt
	 *  has been accepted by the host (not when the agent finishes). */
	send(text: string): Promise<void>
	/** Register a callback that returns a natural-language description of
	 *  current UI/app state for the agent. The host may call this at any
	 *  time. Only the last registered callback is active. May be async. */
	describe(callback: () => string | Promise<string>): void
	/** Register and manage client-side agent tools. Tool handlers run in
	 *  this iframe; the host exposes them as proxy tools to the agent. */
	readonly tools: AppToolRegistry
}

export interface App {
	/** Host SDK API version. Bumped on breaking changes to `window.app`. */
	readonly version: number
	readonly lifecycle: AppLifecycle
	readonly volume: AppVolume
	/** Typed access to host capabilities. Calls route through one generic
	 *  invocation path; the broker enforces grants and resolves accounts.
	 *  Rejections carry stable `code` values (`capability_denied`,
	 *  `capability_failed`) and a `data` envelope with `capability` + `method`. */
	readonly capabilities: AppCapabilities
	/** App-to-agent bridge. Lets the app push prompts into the host's chat
	 *  flow without app-authored server-side code. */
	readonly agent: AppAgent
}
