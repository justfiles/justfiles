// LEGACY (state-machine apps). Slated for removal alongside the
// state-machine app system — see #76. New apps use `./sdk` instead.

import type { Action, DispatchResult } from './index.js'

declare global {
	interface Window {
		app: {
			readonly state: unknown
			subscribe(listener: (state: unknown) => void): () => void
			dispatch(action: Action): Promise<DispatchResult<unknown, unknown>>
		}
	}
}
