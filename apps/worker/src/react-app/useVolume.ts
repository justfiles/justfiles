import type { MemoryMeta } from '@ghostore/core'
import type { LinkInfo } from '@ghostore/core'
import {
	createContext,
	createElement,
	Fragment,
	useContext,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
	type ReactNode,
} from 'react'
import {
	cachedStorage,
	decodeXattr,
	fs as createFs,
	GHOSTORE_XATTR,
	idbStorage,
	type Volume,
	volume as createVolume,
} from 'ghost-fs'
import { FileType } from 'ghost-fs/types'
import { apiStorage } from './storage.api'
import { createMemoryIndex, type MemoryIndex } from './memoryIndex'
import { type FsClient, useFsClient } from './useApiClient'

type MemoryRecord = {
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
	resolveMemory(id: string): Promise<{ entry: MemoryMeta | null, record: MemoryRecord | null }>
}

export interface VolumeService {
	readonly volume: Volume
	readonly index: MemoryIndex
	readonly entries: MemoryMeta[]
	fetchChanges(since?: string): Promise<void>
	refresh(): Promise<void>
	upsertEntry(entry: MemoryMeta): void
	removeEntry(id: string): void
	resolveMemory(id: string): Promise<{ entry: MemoryMeta | null, record: MemoryRecord | null }>
}

const VolumeContext = createContext<VolumeRuntime | null>(null)
const runtimeSingletons = new Map<string, Promise<VolumeRuntime>>()

function lsCacheKey(userId: string) {
	return `ghostore:${userId}:sidebar`
}

const DRAFT_PATH = '/*draft*'
const textDecoder = new TextDecoder()

function normalizeCachedEntry(value: unknown): MemoryMeta | null {
	if (typeof value !== 'object' || value === null) return null

	const entry = value as Partial<MemoryMeta>
	if (typeof entry.id !== 'string') return null
	if (typeof entry.path !== 'string') return null
	if (typeof entry.updated_at !== 'string') return null
	if (!Array.isArray(entry.tags) || !entry.tags.every((tag) => typeof tag === 'string')) return null

	return {
		id: entry.id,
		title: entry.title ?? null,
		path: entry.path,
		updated_at: entry.updated_at,
		tags: entry.tags,
		active: entry.active ?? 1,
	}
}

function loadCache(userId: string): MemoryMeta[] {
	try {
		const raw = JSON.parse(localStorage.getItem(lsCacheKey(userId)) ?? '[]')
		if (!Array.isArray(raw)) return []
		return raw
			.map((entry) => normalizeCachedEntry(entry))
			.filter((entry): entry is MemoryMeta => entry !== null)
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

function toMemoryMeta(record: MemoryRecord): MemoryMeta {
	return {
		id: record.id,
		title: record.title,
		path: record.path,
		updated_at: record.updated_at,
		tags: record.tags,
		active: record.active,
	}
}

function toVolumePath(path: string): string {
	return path.startsWith('/') ? path : `/${path}`
}

function entryPath(path: string): string {
	return path.startsWith('/') ? path.slice(1) : path
}

function isoFromNs(ns: bigint): string {
	return new Date(Number(ns / 1_000_000n)).toISOString()
}

function entryIdentity(path: string): string {
	return entryPath(path)
}

async function decodeOptionalXattr<T>(volume: Volume, path: string, name: string): Promise<T | null> {
	const raw = await volume.getXattr(path, name)
	return raw ? decodeXattr<T>(raw) : null
}

async function readMemoryRecord(volume: Volume, path: string, id?: string): Promise<MemoryRecord> {
	const [stat, rawText, title, tags, links, source] = await Promise.all([
		volume.stat(path),
		volume.readFile(path),
		decodeOptionalXattr<string>(volume, path, GHOSTORE_XATTR.title),
		decodeOptionalXattr<string[]>(volume, path, GHOSTORE_XATTR.tags),
		decodeOptionalXattr<LinkInfo[]>(volume, path, GHOSTORE_XATTR.links),
		decodeOptionalXattr<string>(volume, path, GHOSTORE_XATTR.source),
	])

	return {
		id: id ?? stat.ino,
		raw_text: textDecoder.decode(rawText),
		path: entryPath(path),
		title,
		source,
		tags: tags ?? [],
		links: links ?? [],
		created_at: isoFromNs(stat.ctimeNs),
		updated_at: isoFromNs(stat.mtimeNs),
		active: 1,
	}
}

async function listMemoryEntries(volume: Volume, previous: MemoryMeta[]): Promise<MemoryMeta[]> {
	const entries: MemoryMeta[] = []
	const previousById = new Map(previous.map((entry) => [entry.id, entry]))
	const previousByPath = new Map(previous.map((entry) => [entry.path, entry]))

	await volume.scan('/', async (path, stat) => {
		if (stat.type !== FileType.Regular) return
		if (path === DRAFT_PATH) return

		const currentPath = entryIdentity(path)
		const cached = previousById.get(stat.ino) ?? previousByPath.get(currentPath)

		entries.push({
			id: stat.ino,
			title: cached?.title ?? null,
			path: currentPath,
			updated_at: isoFromNs(stat.mtimeNs),
			tags: cached?.tags ?? [],
			active: 1,
		})
	})

	return entries.sort((left, right) => left.path.localeCompare(right.path))
}

async function createVolumeRuntime(userId: string, fsClient: FsClient): Promise<VolumeRuntime> {
	const local = idbStorage('ghostore-fs')
	const remote = await apiStorage(fsClient)
	const storage = cachedStorage(local, remote)
	const volume = createVolume(createFs(storage))
	const index = createMemoryIndex()
	const listeners = new Set<() => void>()
	let entries = loadCache(userId)
	let snapshot: VolumeSnapshot = { entries }
	let started = false
	let onFocus: (() => void) | null = null
	let hasInitialRefresh = false
	let refreshPromise: Promise<void> | null = null

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

	async function refresh(): Promise<void> {
		if (refreshPromise) return refreshPromise

		refreshPromise = (async () => {
			try {
				setEntries(await listMemoryEntries(volume, entries))
				hasInitialRefresh = true
			} catch {
				// keep serving from cache silently
			} finally {
				refreshPromise = null
			}
		})()

		return refreshPromise
	}

	async function fetchChanges(_since?: string): Promise<void> {
		await refresh()
	}

	function upsertEntry(entry: MemoryMeta) {
		setEntries(applyDelta(entries, [entry]))
	}

	function removeEntry(id: string) {
		setEntries(entries.map((entry) => entry.id === id ? { ...entry, active: 0 } : entry))
	}

	async function resolveMemory(id: string): Promise<{
		entry: MemoryMeta | null
		record: MemoryRecord | null
	}> {
		try {
			let entry = index.get(id)
			if (!entry) {
				await refresh()
				entry = index.get(id)
			}
			if (!entry) return { entry: null, record: null }

			const record = await readMemoryRecord(volume, toVolumePath(entry.path), entry.id)
			const nextEntry = toMemoryMeta(record)
			upsertEntry(nextEntry)
			return { entry: nextEntry, record }
		} catch {
			return { entry: index.get(id), record: null }
		}
	}

	return {
		volume,
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
			if (!hasInitialRefresh) {
				void refresh()
			}
			onFocus = () => {
				void refresh()
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
		refresh,

		upsertEntry,
		removeEntry,
		resolveMemory,
	}
}

function getOrCreateVolumeRuntime(userId: string, fsClient: FsClient): Promise<VolumeRuntime> {
	const existing = runtimeSingletons.get(userId)
	if (existing) return existing

	const promise = createVolumeRuntime(userId, fsClient)
	runtimeSingletons.set(userId, promise)
	return promise
}

export function VolumeProvider({
	children,
	userId,
	fallback = null,
}: {
	children: ReactNode
	userId: string
	fallback?: ReactNode
}) {
	const fsClient = useFsClient()
	const [runtime, setRuntime] = useState<VolumeRuntime | null>(null)

	useEffect(() => {
		let active = true
		getOrCreateVolumeRuntime(userId, fsClient).then((r) => {
			if (active) setRuntime(r)
		})
		return () => { active = false }
	}, [userId, fsClient])

	useEffect(() => {
		if (!runtime) return
		runtime.start()
		return () => runtime.stop()
	}, [runtime])

	if (!runtime) return createElement(Fragment, null, fallback)

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
