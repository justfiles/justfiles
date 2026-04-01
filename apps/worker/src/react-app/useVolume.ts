import type { MemoryMeta, LinkInfo } from '@ghostore/core'
import {
	createContext,
	createElement,
	useContext,
	useEffect,
	useMemo,
	useSyncExternalStore,
	type ReactNode,
} from 'react'
import {
	cachedStorage,
	fs as createFs,
	idbStorage,
	type Volume,
	volume as createVolume,
} from 'ghost-fs'
import { apiStorage } from './storage.api'
import { createMemoryIndex, type MemoryIndex } from './memoryIndex'
import { type ApiClient, useApiClient } from './useApiClient'

export interface ArchivedMemoryData {
	id: string
	raw_text: string
	path: string
	title: string | null
	source: string | null
	tags: string[]
	links: LinkInfo[]
	created_at: string
	updated_at: string
	active: number
}

interface VolumeSnapshot {
	entries: MemoryMeta[]
}

interface VolumeRuntime {
	readonly volume: Volume
	readonly index: MemoryIndex
	subscribe(listener: () => void): () => void
	getSnapshot(): VolumeSnapshot
	start(): void
	stop(): void
	fetchChanges(since?: string): Promise<void>
	refresh(): Promise<void>
	upsertEntry(entry: MemoryMeta): void
	removeEntry(id: string): void
	resolveMemory(id: string): Promise<{ entry: MemoryMeta | null, archived: ArchivedMemoryData | null }>
}

export interface VolumeService {
	readonly volume: Volume
	readonly index: MemoryIndex
	readonly entries: MemoryMeta[]
	fetchChanges(since?: string): Promise<void>
	refresh(): Promise<void>
	upsertEntry(entry: MemoryMeta): void
	removeEntry(id: string): void
	resolveMemory(id: string): Promise<{ entry: MemoryMeta | null, archived: ArchivedMemoryData | null }>
}

const VolumeContext = createContext<VolumeRuntime | null>(null)
const runtimeSingletons = new Map<string, VolumeRuntime>()

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

function applyDelta(cache: MemoryMeta[], upserted: MemoryMeta[]): MemoryMeta[] {
	const map = new Map(cache.map((entry) => [entry.id, entry]))
	for (const entry of upserted) map.set(entry.id, entry)
	return [...map.values()].sort((left, right) => left.path.localeCompare(right.path))
}

function maxUpdatedAt(entries: MemoryMeta[]): string {
	return entries.reduce((max, entry) => (entry.updated_at > max ? entry.updated_at : max), '')
}

function toMemoryMeta(record: ArchivedMemoryData): MemoryMeta {
	return {
		id: record.id,
		title: record.title,
		path: record.path,
		updated_at: record.updated_at,
		tags: record.tags,
		active: record.active,
	}
}

function createVolumeRuntime(userId: string, api: ApiClient): VolumeRuntime {
	const local = idbStorage('ghostore-fs')
	const remote = apiStorage(api)
	const storage = cachedStorage(local, remote)
	const vfs = createFs(storage)
	const index = createMemoryIndex()
	const listeners = new Set<() => void>()
	let entries = loadCache(userId)
	let snapshot: VolumeSnapshot = { entries }
	let started = false
	let onFocus: (() => void) | null = null

	index.hydrate(entries)

	function notify() {
		for (const listener of listeners) listener()
	}

	function setEntries(next: MemoryMeta[]) {
		entries = next
		snapshot = { entries }
		index.hydrate(entries)
		saveCache(userId, entries)
		notify()
	}

	async function fetchChanges(since?: string): Promise<void> {
		const effectiveSince = since ?? maxUpdatedAt(entries)

		try {
			const res = await api.v1.changes.$get({ query: { since: effectiveSince } })
			if (!res.ok) return
			const delta = await res.json()
			if (delta.upserted.length === 0) return
			setEntries(applyDelta(entries, delta.upserted))
		} catch {
			// network error — keep serving from cache silently
		}
	}

	function upsertEntry(entry: MemoryMeta) {
		setEntries(applyDelta(entries, [entry]))
	}

	function removeEntry(id: string) {
		setEntries(entries.map((entry) => entry.id === id ? { ...entry, active: 0 } : entry))
	}

	async function resolveMemory(id: string): Promise<{
		entry: MemoryMeta | null
		archived: ArchivedMemoryData | null
	}> {
		const existing = index.get(id)
		if (existing && existing.active !== 0) {
			return { entry: existing, archived: null }
		}

		try {
			const res = await api.v1.memory[':id'].$get({ param: { id } })
			if (!res.ok) return { entry: existing, archived: null }
			const record = await res.json() as ArchivedMemoryData
			if (record.active !== 0) {
				const entry = toMemoryMeta(record)
				upsertEntry(entry)
				return { entry, archived: null }
			}
			return { entry: null, archived: record }
		} catch {
			return { entry: existing, archived: null }
		}
	}

	return {
		volume: createVolume(vfs),
		index,

		subscribe(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},

			getSnapshot() {
				return snapshot
			},

		start() {
			if (started) return
			started = true
			void fetchChanges()
			onFocus = () => {
				void fetchChanges()
			}
			window.addEventListener('focus', onFocus)
		},

		stop() {
			if (!started) return
			started = false
			if (onFocus) {
				window.removeEventListener('focus', onFocus)
				onFocus = null
			}
		},

		fetchChanges,

		refresh() {
			return fetchChanges('')
		},

		upsertEntry,
		removeEntry,
		resolveMemory,
	}
}

function getOrCreateVolumeRuntime(userId: string, api: ApiClient): VolumeRuntime {
	const existing = runtimeSingletons.get(userId)
	if (existing) return existing

	const runtime = createVolumeRuntime(userId, api)
	runtimeSingletons.set(userId, runtime)
	return runtime
}

export function VolumeProvider({
	children,
	userId,
}: {
	children: ReactNode
	userId: string
}) {
	const api = useApiClient()
	const runtime = useMemo(() => getOrCreateVolumeRuntime(userId, api), [api, userId])

	useEffect(() => {
		runtime.start()
		return () => runtime.stop()
	}, [runtime])

	return createElement(VolumeContext.Provider, { value: runtime }, children)
}

export function useVolume(): VolumeService {
	const runtime = useContext(VolumeContext)
	if (!runtime) throw new Error('useVolume must be used within a VolumeProvider')

	const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot)

	return useMemo(() => ({
		volume: runtime.volume,
		index: runtime.index,
		entries: snapshot.entries,
		fetchChanges: runtime.fetchChanges,
		refresh: runtime.refresh,
		upsertEntry: runtime.upsertEntry,
		removeEntry: runtime.removeEntry,
		resolveMemory: runtime.resolveMemory,
	}), [runtime, snapshot.entries])
}
