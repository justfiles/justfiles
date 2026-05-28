import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector'
import type { Store } from './index.ts'

export function useStore<State, Action, T>(
	store: Store<State, Action>,
	selector: (state: State) => T,
	equal?: (a: T, b: T) => boolean
): T {
	return useSyncExternalStoreWithSelector(
		store.subscribe,
		store.getState,
		store.getState,
		selector,
		equal
	)
}
