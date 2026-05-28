import { createStore, type Store } from '@justfiles/state'
import type { Volume } from '../fs'
import type * as kernelAppHostModule from '../kernelAppHost'
import { makeKernelHostEffect, makePersistEffect } from './effects'
import { osReducer } from './reducer'
import { initialState, type OsAction, type OsState } from './state'

export interface CreateOsStoreOptions {
	kernelAppHost: Pick<typeof kernelAppHostModule, 'open' | 'close'>
	getToken: () => Promise<string | null>
	guiUrlFor: (appId: string) => string | undefined
	send: (frame: object) => void
	volume: Volume
	// Bytes loaded from disk, forwarded to the persist effect so hydration
	// doesn't immediately rewrite the snapshot it just read.
	initialSerialized?: string | null
}

export function createOsStore(options: CreateOsStoreOptions): Store<OsState, OsAction> {
	return createStore({
		initialState,
		reducer: osReducer,
		effects: [
			makeKernelHostEffect(options),
			makePersistEffect({ volume: options.volume, initialSerialized: options.initialSerialized })
		]
	})
}
