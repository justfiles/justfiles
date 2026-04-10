import {
	createContext,
	createElement,
	Fragment,
	useContext,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
	type ReactNode
} from 'react'
import {
	decodeXattr,
	GHOSTORE_XATTR,
	synced,
	type Volume,
	volume as createVolume,
} from '@justfiles/fs'
import { idbStorage } from '@justfiles/fs/storage/idb'
import { FileType } from '@justfiles/fs/types'
import { apiStorage } from './storage.api'
import { createMemoryIndex, type MemoryIndex } from './memoryIndex'
import { type FsClient, useFsClient } from './useApiClient'
import {
	assetDirPath,
	assetUrlForIno,
	basename,
	displayFilenameFromSrc,
	isAssetPath,
	nextAssetPath,
	normalizeVolumePath,
	parentVolumePath,
	resolveRelativeFsPath
} from './assets'
import type { FileMeta, LinkInfo } from './types'

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
	entries: FileMeta[]
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
	upsertEntry(entry: FileMeta): void
	removeEntry(id: string): void
	moveMemory(id: string, path: string, options?: { dedupe?: boolean }): Promise<string>
	archiveMemory(id: string): Promise<void>
	reviveMemory(id: string): Promise<void>
	resolveMemory(id: string): Promise<{ entry: FileMeta | null; record: MemoryRecord | null }>
	writeAssetFile(file: File): Promise<string>
	resolveAssetUrl(notePath: string, src: string): Promise<string | null>
	readAssetBlob(notePath: string, src: string): Promise<Blob | null>
}

export interface VolumeService {
	readonly volume: Volume
	readonly index: MemoryIndex
	readonly entries: FileMeta[]
	fetchChanges(since?: string): Promise<void>
	refresh(): Promise<void>
	upsertEntry(entry: FileMeta): void
	removeEntry(id: string): void
	moveMemory(id: string, path: string, options?: { dedupe?: boolean }): Promise<string>
	archiveMemory(id: string): Promise<void>
	reviveMemory(id: string): Promise<void>
	resolveMemory(id: string): Promise<{ entry: FileMeta | null; record: MemoryRecord | null }>
	writeAssetFile(file: File): Promise<string>
	resolveAssetUrl(notePath: string, src: string): Promise<string | null>
	readAssetBlob(notePath: string, src: string): Promise<Blob | null>
}

const VolumeContext = createContext<VolumeRuntime | null>(null)
const runtimeSingletons = new Map<string, Promise<VolumeRuntime>>()

const LEGACY_DRAFT_PATH = '/*draft*'
const SCRATCH_PATH = '/*scratch*'
const STATE_ROOT = '/.state'
const TRASH_ROOT = '/.trash'
const TRASH_FILES_PATH = `${TRASH_ROOT}/files`
const TRASH_INFO_PATH = `${TRASH_ROOT}/info`
const textDecoder = new TextDecoder()
const textEncoder = new TextEncoder()

type ArchiveInfo = {
	id: string
	originalPath: string
	archivedAt: string
}

function splitFilename(filename: string): { stem: string; extension: string } {
	const idx = filename.lastIndexOf('.')
	if (idx <= 0) return { stem: filename, extension: '' }
	return {
		stem: filename.slice(0, idx),
		extension: filename.slice(idx)
	}
}

function applyDelta(cache: FileMeta[], upserted: FileMeta[]): FileMeta[] {
	const map = new Map(cache.map((entry) => [entry.id, entry]))
	for (const entry of upserted) map.set(entry.id, entry)
	return [...map.values()].sort((left, right) => left.path.localeCompare(right.path))
}

function toFileMeta(record: MemoryRecord): FileMeta {
	return {
		id: record.id,
		title: record.title,
		path: record.path,
		updated_at: record.updated_at,
		tags: record.tags,
		active: record.active
	}
}

function toVolumePath(path: string): string {
	return path.startsWith('/') ? path : `/${path}`
}

function fromVolumePath(path: string): string {
	return path.startsWith('/') ? path.slice(1) : path
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

async function decodeOptionalXattr<T>(
	volume: Volume,
	path: string,
	name: string
): Promise<T | null> {
	const raw = await volume.getXattr(path, name)
	return raw ? decodeXattr<T>(raw) : null
}

function trashFilePath(id: string): string {
	return `${TRASH_FILES_PATH}/${id}`
}

function trashInfoPath(id: string): string {
	return `${TRASH_INFO_PATH}/${id}.json`
}

function isTrashPath(path: string): boolean {
	return path === TRASH_ROOT || path.startsWith(`${TRASH_ROOT}/`)
}

const SHOW_STATE_FOLDER = true

function isStatePath(path: string): boolean {
	return path === STATE_ROOT || path.startsWith(`${STATE_ROOT}/`)
}

async function ensureTrashDirs(volume: Volume): Promise<void> {
	await volume.mkdir(TRASH_FILES_PATH, { recursive: true })
	await volume.mkdir(TRASH_INFO_PATH, { recursive: true })
}

function parseArchiveInfo(value: unknown): ArchiveInfo | null {
	if (typeof value !== 'object' || value === null) return null
	const info = value as Partial<ArchiveInfo>
	if (typeof info.id !== 'string') return null
	if (typeof info.originalPath !== 'string') return null
	if (typeof info.archivedAt !== 'string') return null
	return {
		id: info.id,
		originalPath: info.originalPath,
		archivedAt: info.archivedAt
	}
}

async function readArchiveInfo(volume: Volume, id: string): Promise<ArchiveInfo | null> {
	try {
		const raw = await volume.readFile(trashInfoPath(id))
		return parseArchiveInfo(JSON.parse(textDecoder.decode(raw)))
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (message.startsWith('ENOENT:')) return null
		throw error
	}
}

async function writeArchiveInfo(volume: Volume, info: ArchiveInfo): Promise<void> {
	await volume.writeFile(trashInfoPath(info.id), textEncoder.encode(JSON.stringify(info)))
}

async function readMemoryRecord(
	volume: Volume,
	path: string,
	options?: { id?: string; logicalPath?: string; active?: number; updatedAt?: string }
): Promise<MemoryRecord> {
	const [stat, rawText, title, tags, links, source] = await Promise.all([
		volume.stat(path),
		volume.readFile(path),
		decodeOptionalXattr<string>(volume, path, GHOSTORE_XATTR.title),
		decodeOptionalXattr<string[]>(volume, path, GHOSTORE_XATTR.tags),
		decodeOptionalXattr<LinkInfo[]>(volume, path, GHOSTORE_XATTR.links),
		decodeOptionalXattr<string>(volume, path, GHOSTORE_XATTR.source)
	])

	return {
		id: options?.id ?? stat.ino,
		raw_text: textDecoder.decode(rawText),
		path: options?.logicalPath ?? entryPath(path),
		title,
		source,
		tags: tags ?? [],
		links: links ?? [],
		created_at: isoFromNs(stat.ctimeNs),
		updated_at: options?.updatedAt ?? isoFromNs(stat.mtimeNs),
		active: options?.active ?? 1
	}
}

async function listLiveMemoryEntries(
	volume: Volume,
	previous: FileMeta[]
): Promise<FileMeta[]> {
	const entries: FileMeta[] = []
	const previousLive = previous.filter((entry) => entry.active !== 0)
	const previousById = new Map(previousLive.map((entry) => [entry.id, entry]))
	const previousByPath = new Map(previousLive.map((entry) => [entry.path, entry]))

	await volume.scan('/', async (path, stat) => {
		if (stat.type !== FileType.Regular) return
		if (path === LEGACY_DRAFT_PATH || path === SCRATCH_PATH) return
		if (!SHOW_STATE_FOLDER && isStatePath(path)) return
		if (isTrashPath(path)) return
		if (isAssetPath(path)) return

		const currentPath = entryIdentity(path)
		const cached = previousById.get(stat.ino) ?? previousByPath.get(currentPath)

		entries.push({
			id: stat.ino,
			title: cached?.title ?? null,
			path: currentPath,
			updated_at: isoFromNs(stat.mtimeNs),
			tags: cached?.tags ?? [],
			active: 1
		})
	})

	return entries.sort((left, right) => left.path.localeCompare(right.path))
}

async function listArchivedMemoryEntries(volume: Volume): Promise<FileMeta[]> {
	if (!(await volume.exists(TRASH_FILES_PATH))) return []

	const entries: FileMeta[] = []

	await volume.scan(TRASH_FILES_PATH, async (path, stat) => {
		if (path === TRASH_FILES_PATH) return
		if (stat.type !== FileType.Regular) return

		const id = fromVolumePath(path).split('/').pop()
		if (!id) return

		const info = await readArchiveInfo(volume, id)
		if (!info) return

		const [title, tags] = await Promise.all([
			decodeOptionalXattr<string>(volume, path, GHOSTORE_XATTR.title),
			decodeOptionalXattr<string[]>(volume, path, GHOSTORE_XATTR.tags)
		])

		entries.push({
			id,
			title,
			path: info.originalPath,
			updated_at: info.archivedAt,
			tags: tags ?? [],
			active: 0
		})
	})

	return entries.sort((left, right) => left.path.localeCompare(right.path))
}

async function listMemoryEntries(volume: Volume, previous: FileMeta[]): Promise<FileMeta[]> {
	const [liveEntries, archivedEntries] = await Promise.all([
		listLiveMemoryEntries(volume, previous),
		listArchivedMemoryEntries(volume)
	])
	return [...liveEntries, ...archivedEntries].sort((left, right) =>
		left.path.localeCompare(right.path)
	)
}

async function loadInitialEntries(
	volume: Volume
): Promise<{ entries: FileMeta[]; loaded: boolean }> {
	try {
		return {
			entries: await listMemoryEntries(volume, []),
			loaded: true
		}
	} catch {
		return {
			entries: [],
			loaded: false
		}
	}
}

async function createVolumeRuntime(fsClient: FsClient): Promise<VolumeRuntime> {
	const local = idbStorage('justfiles-fs')
	const remote = await apiStorage(fsClient)
	const volume = await synced({ local, remote, lazyContent: true })
	const remoteVolume = createVolume(remote)
	const index = createMemoryIndex()
	const listeners = new Set<() => void>()
	const initialEntries = await loadInitialEntries(volume)
	let entries = initialEntries.entries
	let snapshot: VolumeSnapshot = { entries }
	let started = false
	let onFocus: (() => void) | null = null
	let hasInitialRefresh = initialEntries.loaded
	let refreshPromise: Promise<void> | null = null

	index.hydrate(entries)

	function notify() {
		for (const listener of listeners) listener()
	}

	function setEntries(next: FileMeta[]) {
		entries = next
		snapshot = { entries }
		index.hydrate(entries)
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

	function upsertEntry(entry: FileMeta) {
		setEntries(applyDelta(entries, [entry]))
	}

	function removeEntry(id: string) {
		setEntries(entries.map((entry) => (entry.id === id ? { ...entry, active: 0 } : entry)))
	}

	async function moveMemory(id: string, path: string, options?: { dedupe?: boolean }): Promise<string> {
		let entry = index.get(id)
		if (!entry) {
			await refresh()
			entry = index.get(id)
		}
		if (!entry) throw new Error(`ENOENT: ${id}`)
		if (entry.active === 0) throw new Error(`EINVAL: ${id}`)

		const normalizedOldPath = toVolumePath(entry.path)
		const requestedPath = normalizeVolumePath(path)
		const targetDir = parentVolumePath(requestedPath)
		const { stem, extension } = splitFilename(basename(requestedPath))

		let resolvedPath = requestedPath
		if (options?.dedupe) {
			let attempt = 1
			while (resolvedPath !== normalizedOldPath && await volume.exists(resolvedPath)) {
				attempt += 1
				resolvedPath = normalizeVolumePath(`${targetDir}/${stem} ${attempt}${extension}`)
			}
		}

		if (resolvedPath === normalizedOldPath) return entry.path

		await volume.mkdir(parentVolumePath(resolvedPath), { recursive: true })
		await volume.rename(normalizedOldPath, resolvedPath)

		const now = new Date().toISOString()
		const nextPath = resolvedPath.slice(1)
		upsertEntry({
			...entry,
			path: nextPath,
			updated_at: now,
			active: 1
		})
		return nextPath
	}

	async function archiveMemory(id: string): Promise<void> {
		let entry = index.get(id)
		if (!entry) {
			await refresh()
			entry = index.get(id)
		}
		if (!entry) throw new Error(`ENOENT: ${id}`)
		if (entry.active === 0) return

		const archivedAt = new Date().toISOString()
		const sourcePath = toVolumePath(entry.path)
		const destinationPath = trashFilePath(id)
		const info: ArchiveInfo = {
			id,
			originalPath: entry.path,
			archivedAt
		}

		await ensureTrashDirs(volume)
		if (await volume.exists(destinationPath)) {
			throw new Error(`EEXIST: ${destinationPath}`)
		}

		await writeArchiveInfo(volume, info)
		try {
			await volume.rename(sourcePath, destinationPath)
		} catch (error) {
			await volume.rm(trashInfoPath(id), { force: true })
			throw error
		}

		upsertEntry({
			...entry,
			updated_at: archivedAt,
			active: 0
		})
	}

	async function reviveMemory(id: string): Promise<void> {
		const info = await readArchiveInfo(volume, id)
		if (!info) throw new Error(`ENOENT: ${id}`)

		const sourcePath = trashFilePath(id)
		const destinationPath = toVolumePath(info.originalPath)
		if (!(await volume.exists(sourcePath))) {
			throw new Error(`ENOENT: ${id}`)
		}
		if (await volume.exists(destinationPath)) {
			throw new Error(`EEXIST: ${info.originalPath}`)
		}

		await volume.mkdir(parentVolumePath(info.originalPath), { recursive: true })
		await volume.rename(sourcePath, destinationPath)
		await volume.rm(trashInfoPath(id), { force: true })

		const record = await readMemoryRecord(volume, destinationPath, {
			id,
			logicalPath: info.originalPath,
			active: 1
		})
			upsertEntry(toFileMeta(record))
		}

		async function resolveMemory(id: string): Promise<{
			entry: FileMeta | null
			record: MemoryRecord | null
		}> {
		try {
			let entry = index.get(id)
			if (!entry) {
				await refresh()
				entry = index.get(id)
			}
			if (!entry) {
				const info = await readArchiveInfo(volume, id)
				if (!info) return { entry: null, record: null }
				entry = {
					id,
					title: null,
					path: info.originalPath,
					updated_at: info.archivedAt,
					tags: [],
					active: 0
				}
			}

			const physicalPath = entry.active === 0 ? trashFilePath(entry.id) : toVolumePath(entry.path)
			const record = await readMemoryRecord(volume, physicalPath, {
				id: entry.id,
				logicalPath: entry.path,
				active: entry.active,
				updatedAt: entry.active === 0 ? entry.updated_at : undefined
			})
				const nextEntry = toFileMeta(record)
			upsertEntry(nextEntry)
			return { entry: nextEntry, record }
		} catch {
			return { entry: index.get(id), record: null }
		}
	}

	async function writeAssetFile(file: File): Promise<string> {
		const assetPath = nextAssetPath(file.name || 'asset.bin')
		const assetDir = assetDirPath()
		const bytes = new Uint8Array(await file.arrayBuffer())

		// Editor-inserted assets must be readable immediately by the preview
		// renderer, which fetches through the authenticated remote /fs route.
		// Write them to remote synchronously instead of relying on local
		// write-behind flush timing.
		await remoteVolume.mkdir(assetDir, { recursive: true })
		await remoteVolume.writeFile(assetPath, bytes)

		return assetPath
	}

	async function resolveAssetUrl(notePath: string, src: string): Promise<string | null> {
		const resolvedPath = resolveRelativeFsPath(notePath, src)
		if (!resolvedPath) return src

		// Fall back to remoteVolume if the synced volume hasn't pulled the asset yet
		// (e.g. immediately after writeAssetFile which writes to remote only).
		const stat = await volume.stat(resolvedPath).catch(() => remoteVolume.stat(resolvedPath).catch(() => null))
		if (!stat || stat.type !== FileType.Regular) return null

		return assetUrlForIno(
			stat.ino,
			displayFilenameFromSrc(src),
			stat.contentHash ?? stat.mtimeNs.toString()
		)
	}

	async function readAssetBlob(notePath: string, src: string): Promise<Blob | null> {
		const resolvedPath = resolveRelativeFsPath(notePath, src)
		if (!resolvedPath) {
			const res = await fetch(src)
			if (!res.ok) return null
			return await res.blob()
		}

		// Fall back to remoteVolume if the synced volume hasn't pulled the asset yet.
		const stat = await volume.stat(resolvedPath).catch(() => remoteVolume.stat(resolvedPath).catch(() => null))
		if (!stat || stat.type !== FileType.Regular) return null

		const filename = displayFilenameFromSrc(src)
		const res = await fsClient.inodes[':ino'].content[':filename'].$get({
			param: { ino: stat.ino, filename }
		})
		if (!res.ok) return null
		return await res.blob()
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
		moveMemory,
		archiveMemory,
		reviveMemory,
		resolveMemory,
		writeAssetFile,
		resolveAssetUrl,
		readAssetBlob
	}
}

function getOrCreateVolumeRuntime(userId: string, fsClient: FsClient): Promise<VolumeRuntime> {
	const existing = runtimeSingletons.get(userId)
	if (existing) return existing

	const promise = createVolumeRuntime(fsClient)
	runtimeSingletons.set(userId, promise)
	return promise
}

export function VolumeProvider({
	children,
	userId,
	fallback = null
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
		return () => {
			active = false
		}
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

	return useMemo(
		() => ({
			volume: runtime.volume,
			index: runtime.index,
			entries: snapshot.entries,
			fetchChanges: runtime.fetchChanges,
			refresh: runtime.refresh,
			upsertEntry: runtime.upsertEntry,
			removeEntry: runtime.removeEntry,
			moveMemory: runtime.moveMemory,
			archiveMemory: runtime.archiveMemory,
			reviveMemory: runtime.reviveMemory,
			resolveMemory: runtime.resolveMemory,
			writeAssetFile: runtime.writeAssetFile,
			resolveAssetUrl: runtime.resolveAssetUrl,
			readAssetBlob: runtime.readAssetBlob
		}),
		[runtime, snapshot.entries]
	)
}
