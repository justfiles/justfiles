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

function lsCacheKey(userId: string) {
	return `ghostore:${userId}:sidebar`
}

function loadCache(userId: string): MemoryMeta[] {
	try {
		return JSON.parse(localStorage.getItem(lsCacheKey(userId)) ?? '[]')
	} catch {
		return []
	}
}

function saveCache(userId: string, entries: MemoryMeta[]) {
	localStorage.setItem(lsCacheKey(userId), JSON.stringify(entries))
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
	const { getToken, isSignedIn, userId } = useAuth()
	const [entries, setEntries] = useState<MemoryMeta[]>(() => userId ? loadCache(userId) : [])

	const fetchChanges = useCallback(async (since?: string) => {
		if (!isSignedIn || !userId) return
		const token = await getToken()
		if (!token) return

		// Read current cache directly from localStorage to avoid stale closure
		const effectiveSince = since ?? maxUpdatedAt(loadCache(userId))

		try {
			const res = await fetch(`/api/v1/changes?since=${encodeURIComponent(effectiveSince)}`, {
				headers: { Authorization: `Bearer ${token}` },
			})
			if (!res.ok) return
			const delta = (await res.json()) as ChangesResult
			if (delta.upserted.length === 0 && delta.removed.length === 0) return
			setEntries((prev: MemoryMeta[]) => {
				const next = applyDelta(prev, delta)
				saveCache(userId, next)
				return next
			})
		} catch {
			// network error — keep serving from cache silently
		}
	}, [getToken, isSignedIn, userId])

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
			if (userId) saveCache(userId, next)
			return next
		})
	}, [userId])

	// Optimistically remove an entry (call after archive/delete)
	const removeEntry = useCallback((id: string) => {
		setEntries((prev: MemoryMeta[]) => {
			const next = applyDelta(prev, { upserted: [], removed: [id] })
			if (userId) saveCache(userId, next)
			return next
		})
	}, [userId])

	return { entries, fetchChanges, refresh, upsertEntry, removeEntry }
}
