// Browser-shell contracts. The launcher exposes app state and lets the
// host UI start/stop apps; the relay forwards iframe ⇄ server JSON-RPC
// frames and routes server-initiated tool invocations.

import type {
	AppHostRpcMethod,
	AppHostRpcParams,
	AppHostRpcRegistry,
	AppHostRpcResult,
	AppRpcError,
	AppRpcRequest,
	AppRpcResponse
} from './protocol.js'

export type ActiveApp =
	| { kind: 'sandbox'; id: string; ui: { url: string } }
	| { kind: 'builtin'; id: string }

export interface InstalledApp {
	id: string
	name: string
	description: string
	iconUrl?: string
	kind?: 'sandbox' | 'builtin'
}

type ToolInvokeParams = AppHostRpcRegistry['app.tool.invoke']['params']

/** Receives a server-initiated tool invocation; the iframe runs the handler. */
export type ToolInvokeHandler = (
	callId: ToolInvokeParams['callId'],
	name: ToolInvokeParams['name'],
	input: ToolInvokeParams['input']
) => void

/** Sends a tool result back to the server. */
export type ToolResultSender = (callId: string, result?: unknown, error?: AppRpcError) => void

/** Handles a host→iframe call. Resolves with the typed result on success or
 *  with an error envelope on failure. */
export type HostCallHandler = <M extends AppHostRpcMethod>(
	method: M,
	params: AppHostRpcParams<M>
) => Promise<{ result?: AppHostRpcResult<M>; error?: AppRpcError }>

export interface AppLauncher {
	activeApp: ActiveApp | null
	installedApps: InstalledApp[]
	launch(app: InstalledApp): void
	close(): void
}

export interface AppRelay {
	sendRpc(frame: AppRpcRequest): Promise<AppRpcResponse>
	/** Dispatch a host-initiated typed call to the iframe. The relay routes
	 *  to the handler registered via `onHostCall`; resolves with `{ result }`
	 *  on success or `{ error }` when no handler is registered, the iframe
	 *  rejects, or the call times out. */
	callIframe<M extends AppHostRpcMethod>(
		method: M,
		params: AppHostRpcParams<M>
	): Promise<{ result?: AppHostRpcResult<M>; error?: AppRpcError }>
	/** Register the iframe-side handler that fulfils `callIframe` requests.
	 *  Passing `null` clears the handler. */
	onHostCall(handler: HostCallHandler | null): void
	onToolInvoke(handler: ToolInvokeHandler | null): void
	sendToolResult: ToolResultSender
	notifyIframeReload(): void
}
