import type { MemoryMeta } from '@ghostore/core'
import { useVolume } from './useVolume'

export type { MemoryMeta }

export function useSidebar() {
	const { entries, fetchChanges, refresh, upsertEntry, removeEntry } = useVolume()

	return { entries, fetchChanges, refresh, upsertEntry, removeEntry }
}
