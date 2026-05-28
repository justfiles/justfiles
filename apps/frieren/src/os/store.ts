import { createStore, type Store } from '@justfiles/state'
import type { Volume } from '../fs'
import type * as appHostModule from '../apps/host'
import { makeKernelHostEffect, makePersistEffect } from './effects'
import { loadSnapshot } from './persistence'
import { osReducer } from './reducer'
import { initialState, type OsAction, type OsState } from './state'

export interface CreateOsStoreOptions {
	appHost: Pick<typeof appHostModule, 'open' | 'close'>
	getToken: () => Promise<string | null>
	guiUrlFor: (appId: string) => string | undefined
	send: (frame: object) => void
	volume: Promise<Volume>
}

export function createOsStore(options: CreateOsStoreOptions): Store<OsState, OsAction> {
	return createStore({
		initialState,
		reducer: osReducer,
		effects: [makeKernelHostEffect(options), makePersistEffect({ volume: options.volume })]
	})
}

// Hydrate the store from the persisted snapshot. Runs once after the volume is
// available; the reducer forces `booted: true`, lifting the loading gate.
export async function bootOsStore(
	store: Store<OsState, OsAction>,
	volume: Promise<Volume>
): Promise<void> {
	const state = await loadSnapshot(await volume)
	store.dispatch({ type: 'boot/loaded', state })
}
