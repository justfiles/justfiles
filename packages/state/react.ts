import type { Store } from './index.ts'

export function useStore<State, Action, T>(
	_store: Store<State, Action>,
	_selector: (state: State) => T,
	_equal?: (a: T, b: T) => boolean
): T {
	throw new Error('useStore: not implemented (Step 4)')
}
