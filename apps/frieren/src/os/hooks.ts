import type { Store } from '@justfiles/state'
import { useStore } from '@justfiles/state/react'
import { createContext, useContext } from 'react'
import type { OsAction, OsState } from './state'

export interface OsClient {
	send(frame: object): void
	guiUrlFor(appId: string): string | undefined
	setSend(send: (frame: object) => void): () => void
	setGuiUrlFor(guiUrlFor: (appId: string) => string | undefined): () => void
}

export interface OsContextValue {
	store: Store<OsState, OsAction>
	client: OsClient
}

export const OsContext = createContext<OsContextValue | null>(null)

function useOsContext(): OsContextValue {
	const value = useContext(OsContext)
	if (!value) throw new Error('OS hooks must be used inside <OSProvider>')
	return value
}

export function useOsStore<T>(selector: (state: OsState) => T, equal?: (a: T, b: T) => boolean): T {
	return useStore(useOsContext().store, selector, equal)
}

export function useOsDispatch(): Store<OsState, OsAction>['dispatch'] {
	return useOsContext().store.dispatch
}

export function useOsClient(): OsClient {
	return useOsContext().client
}
