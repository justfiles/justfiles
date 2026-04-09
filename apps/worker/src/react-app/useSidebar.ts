import { useVolume } from './useVolume'
import type { FileMeta } from './types'

export type { FileMeta }

export function useSidebar() {
	const { entries, fetchChanges, refresh, upsertEntry, removeEntry } = useVolume()

	return { entries, fetchChanges, refresh, upsertEntry, removeEntry }
}
