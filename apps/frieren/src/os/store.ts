import type { Kernel } from '@justfiles/app'
import { createStore, type Store } from '@justfiles/state'
import type * as appHostModule from '../apps/host'
import type { Volume } from '../fs'
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
	localKernel?: () => Promise<Kernel>
	shouldUseLocalKernel?: (appId: string) => boolean
}

export interface OsStoreHandle {
	store: Store<OsState, OsAction>
	// Flush pending debounced persistence (page hide / provider unmount).
	flushPersist: () => void
}

export function createOsStore(options: CreateOsStoreOptions): OsStoreHandle {
	const persist = makePersistEffect({ volume: options.volume })
	const store = createStore({
		initialState,
		reducer: osReducer,
		effects: [makeKernelHostEffect(options), persist.effect]
	})
	return { store, flushPersist: persist.flush }
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
