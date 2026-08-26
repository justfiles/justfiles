import type { FileMeta } from './types'
import { useVolume } from './useVolume'

export type { FileMeta }

export function useSidebar() {
	const { entries, fetchChanges, refresh, upsertEntry, removeEntry } = useVolume()

	return { entries, fetchChanges, refresh, upsertEntry, removeEntry }
}
