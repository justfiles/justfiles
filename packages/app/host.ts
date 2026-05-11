// Server-side host contract. Owns app lifecycle and dispatches RPC frames
// from the browser shell. Frieren's worker implements this; tests mock it.

import type {
	AppHostRpcMethod,
	AppHostRpcParams,
	AppHostRpcResult,
	AppRpcRequest,
	AppRpcResponse
} from './protocol.js'

export interface AppHost {
	/** Identity of the currently active app, if any. */
	current(): { id: string } | undefined
	/** Launch the app with the given id. Closes the previous active app. */
	launch(id: string): Promise<void>
	/** Close the active app. No-op when no app is active. */
	close(): Promise<void>
	/** Dispatch a JSON-RPC request from the iframe; returns the response. */
	dispatch(frame: AppRpcRequest): Promise<AppRpcResponse>
	/** Typed host→iframe call. Returns `null` when no app is active, no
	 *  client is reachable, or the iframe fails to reply within the host's
	 *  budget — callers branch on data, not exceptions. */
	callActive<M extends AppHostRpcMethod>(
		method: M,
		params: AppHostRpcParams<M>
	): Promise<AppHostRpcResult<M> | null>
}
