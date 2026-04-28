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
