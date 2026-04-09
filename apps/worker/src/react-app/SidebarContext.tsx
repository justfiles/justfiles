import { createContext, useContext } from 'react'
import type { FileMeta } from './types'

type SidebarContextValue = {
	upsertEntry: (entry: FileMeta) => void
	removeEntry: (id: string) => void
	refresh: () => void
}

export const SidebarContext = createContext<SidebarContextValue>({
	upsertEntry: () => {},
	removeEntry: () => {},
	refresh: () => {},
})

export const useSidebarActions = () => useContext(SidebarContext)
