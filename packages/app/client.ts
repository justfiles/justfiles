// Browser-shell contracts. The launcher exposes app state and lets the
// host UI start/stop apps; the relay forwards iframe ⇄ server JSON-RPC
// frames and routes server-initiated tool invocations.

import type { AppHostRpcRegistry, AppRpcError, AppRpcRequest, AppRpcResponse } from './protocol.ts'

export type ActiveApp =
	| { kind: 'sandbox'; id: string; ui: { url: string } }
	| { kind: 'esm'; id: string; manifestUrl: string; baseUrl: string }
	| { kind: 'builtin'; id: string }
	| { kind: 'kernel'; id: string }

export interface InstalledApp {
	id: string
	name: string
	description: string
	iconUrl?: string
	kind?: 'sandbox' | 'esm' | 'builtin' | 'kernel'
	// Present on new-shape (ESM) apps; lets the launcher mount directly
	// without a worker round-trip.
	manifestUrl?: string
	baseUrl?: string
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

export interface AppLauncher {
	activeApp: ActiveApp | null
	installedApps: InstalledApp[]
	launch(app: InstalledApp): void
	close(): void
}

export interface AppRelay {
	sendRpc(frame: AppRpcRequest): Promise<AppRpcResponse>
	onToolInvoke(handler: ToolInvokeHandler | null): void
	sendToolResult: ToolResultSender
	notifyIframeReload(): void
}
