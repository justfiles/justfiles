import { createContext, useContext } from 'react'
import type { MemoryMeta } from '@ghostore/core'

type SidebarContextValue = {
	upsertEntry: (entry: MemoryMeta) => void
	removeEntry: (id: string) => void
	refresh: () => void
}

export const SidebarContext = createContext<SidebarContextValue>({
	upsertEntry: () => {},
	removeEntry: () => {},
	refresh: () => {},
})

export const useSidebarActions = () => useContext(SidebarContext)
