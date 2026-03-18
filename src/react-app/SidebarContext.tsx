import { createContext, useContext } from 'react'
import type { MemoryMeta } from './useSidebar'

type SidebarContextValue = {
	upsertEntry: (entry: MemoryMeta) => void
	removeEntry: (id: string) => void
	refresh: () => void
	toggleSidebar: () => void
	sidebarOpen: boolean
}

export const SidebarContext = createContext<SidebarContextValue>({
	upsertEntry: () => {},
	removeEntry: () => {},
	refresh: () => {},
	toggleSidebar: () => {},
	sidebarOpen: false,
})

export const useSidebarActions = () => useContext(SidebarContext)
