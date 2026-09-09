import type { Kernel } from '@justfiles/app'
import type { Store } from '@justfiles/state'
import { useStore } from '@justfiles/state/react'
import type { SettingsHost } from '@justfiles/ui/settings/types'
import { createContext, useContext } from 'react'
import type { Volume } from '../fs'
import type { AgentClient, FrierenClient } from './client'
import type { OsAction, OsState } from './state'

export interface OsContextValue {
	store: Store<OsState, OsAction>
	client: FrierenClient
	localKernel: () => Promise<Kernel>
	volume: Promise<Volume>
	settings: Promise<SettingsHost>
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

export function useOsClient(): FrierenClient {
	return useOsContext().client
}

export function useOsRuntime(): Pick<OsContextValue, 'localKernel' | 'volume' | 'settings'> {
	const { localKernel, volume, settings } = useOsContext()
	return { localKernel, volume, settings }
}

export function useAgentClient(agentId?: string): AgentClient {
	return useOsContext().client.agent(agentId)
}
