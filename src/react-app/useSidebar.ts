import { useAuth } from '@clerk/clerk-react'
import { useCallback, useEffect, useState } from 'react'

export type MemoryMeta = {
	id: string
	title: string | null
	path: string
	updated_at: string
	tags: string[]
}

type ChangesResult = {
	upserted: MemoryMeta[]
	removed: string[]
}

const LS_KEY = 'ghostore:sidebar'

function loadCache(): MemoryMeta[] {
	try {
		return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]')
	} catch {
		return []
	}
}

function saveCache(entries: MemoryMeta[]) {
	localStorage.setItem(LS_KEY, JSON.stringify(entries))
}

function applyDelta(cache: MemoryMeta[], delta: ChangesResult): MemoryMeta[] {
	const map = new Map(cache.map((e) => [e.id, e]))
	for (const entry of delta.upserted) map.set(entry.id, entry)
	for (const id of delta.removed) map.delete(id)
	return [...map.values()].sort((a, b) => a.path.localeCompare(b.path))
}

function maxUpdatedAt(entries: MemoryMeta[]): string {
	return entries.reduce((max, e) => (e.updated_at > max ? e.updated_at : max), '')
}

export function useSidebar() {
	const { getToken, isSignedIn } = useAuth()
	const [entries, setEntries] = useState<MemoryMeta[]>(loadCache)

	const fetchChanges = useCallback(async (since?: string) => {
		if (!isSignedIn) return
		const token = await getToken()
		if (!token) return

		// Read current cache directly from localStorage to avoid stale closure
		const effectiveSince = since ?? maxUpdatedAt(loadCache())

		try {
			const res = await fetch(`/api/v1/changes?since=${encodeURIComponent(effectiveSince)}`, {
				headers: { Authorization: `Bearer ${token}` },
			})
			if (!res.ok) return
			const delta = (await res.json()) as ChangesResult
			if (delta.upserted.length === 0 && delta.removed.length === 0) return
			setEntries((prev: MemoryMeta[]) => {
				const next = applyDelta(prev, delta)
				saveCache(next)
				return next
			})
		} catch {
			// network error — keep serving from cache silently
		}
	}, [getToken, isSignedIn])

	// Force a full re-sync from the server, ignoring the local cursor
	const refresh = useCallback(() => fetchChanges(''), [fetchChanges])

	// Fetch on mount and on window focus
	useEffect(() => {
		fetchChanges()
		const onFocus = () => fetchChanges()
		window.addEventListener('focus', onFocus)
		return () => window.removeEventListener('focus', onFocus)
	}, [fetchChanges])

	// Optimistically add/update a single entry (call after capture/update)
	const upsertEntry = useCallback((entry: MemoryMeta) => {
		setEntries((prev: MemoryMeta[]) => {
			const next = applyDelta(prev, { upserted: [entry], removed: [] })
			saveCache(next)
			return next
		})
	}, [])

	// Optimistically remove an entry (call after archive/delete)
	const removeEntry = useCallback((id: string) => {
		setEntries((prev: MemoryMeta[]) => {
			const next = applyDelta(prev, { upserted: [], removed: [id] })
			saveCache(next)
			return next
		})
	}, [])

	return { entries, fetchChanges, refresh, upsertEntry, removeEntry }
}
