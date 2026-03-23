import { useAuth } from '@clerk/clerk-react'
import { useCallback, useEffect, useState } from 'react'

export type MemoryMeta = {
	id: string
	title: string | null
	path: string
	updated_at: string
	tags: string[]
	active: number
}

type ChangesResult = {
	upserted: MemoryMeta[]
}

function lsCacheKey(userId: string) {
	return `ghostore:${userId}:sidebar`
}

function loadCache(userId: string): MemoryMeta[] {
	try {
		const raw = JSON.parse(localStorage.getItem(lsCacheKey(userId)) ?? '[]') as Array<Partial<MemoryMeta>>
		return raw.map((e) => ({ ...e, active: e.active ?? 1 }) as MemoryMeta)
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

		const effectiveSince = since ?? maxUpdatedAt(loadCache(userId))

		try {
			const res = await fetch(`/api/v1/changes?since=${encodeURIComponent(effectiveSince)}`, {
				headers: { Authorization: `Bearer ${token}` },
			})
			if (!res.ok) return
			const delta = (await res.json()) as ChangesResult
			if (delta.upserted.length === 0) return
			setEntries((prev) => {
				const next = applyDelta(prev, delta)
				saveCache(userId, next)
				return next
			})
		} catch {
			// network error — keep serving from cache silently
		}
	}, [getToken, isSignedIn, userId])

	const refresh = useCallback(() => fetchChanges(''), [fetchChanges])

	useEffect(() => {
		fetchChanges()
		const onFocus = () => fetchChanges()
		window.addEventListener('focus', onFocus)
		return () => window.removeEventListener('focus', onFocus)
	}, [fetchChanges])

	const upsertEntry = useCallback((entry: MemoryMeta) => {
		setEntries((prev) => {
			const next = applyDelta(prev, { upserted: [entry] })
			if (userId) saveCache(userId, next)
			return next
		})
	}, [userId])

	// Optimistically mark as archived (active=0) without removing from the list
	const removeEntry = useCallback((id: string) => {
		setEntries((prev) => {
			const next = prev.map((e) => e.id === id ? { ...e, active: 0 } : e)
			if (userId) saveCache(userId, next)
			return next
		})
	}, [userId])

	return { entries, fetchChanges, refresh, upsertEntry, removeEntry }
}
