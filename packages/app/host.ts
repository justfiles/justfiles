// Server-side host contract. Owns app lifecycle and dispatches RPC frames
// from the browser shell. Frieren's worker implements this; tests mock it.

import type { AppRpcRequest, AppRpcResponse } from './protocol.ts'

export interface AppHost {
	/** Identity of the currently active app, if any. */
	current(): { id: string } | undefined
	/** Launch the app with the given id. Closes the previous active app. */
	launch(id: string): Promise<void>
	/** Close the active app. No-op when no app is active. */
	close(): Promise<void>
	/** Dispatch a JSON-RPC request from the iframe; returns the response. */
	dispatch(frame: AppRpcRequest): Promise<AppRpcResponse>
}
