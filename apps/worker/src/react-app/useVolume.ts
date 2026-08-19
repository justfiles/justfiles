import { useAuth } from '@clerk/clerk-react'
import { decodeXattr, GHOSTORE_XATTR, type Volume } from '@justfiles/fs'
import { migrateIdb } from '@justfiles/fs/migrate.idb'
import type { Store } from '@justfiles/fs/store'
import { httpStore } from '@justfiles/fs/store.http'
import { idbStore, sharedStore } from '@justfiles/fs/store.idb'
import { type CursorSlot, syncedVolume } from '@justfiles/fs/synced'
import { FileType } from '@justfiles/fs/types'
import {
	createContext,
	createElement,
	Fragment,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore
} from 'react'
import {
	assetDirPath,
	assetUrl,
	basename,
	contentTypeOf,
	displayFilenameFromSrc,
	nextAssetPath,
	normalizeVolumePath,
	parentVolumePath,
	resolveRelativeFsPath
} from './assets'
import { createMemoryIndex, type MemoryIndex } from './memoryIndex'
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

function isHiddenPath(path: string): boolean {
	return path.split('/').some((segment) => segment.length > 0 && segment.startsWith('.'))
}

const SHOW_HIDDEN_FOLDER = false

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

async function listLiveMemoryEntries(volume: Volume, previous: FileMeta[]): Promise<FileMeta[]> {
	const entries: FileMeta[] = []
	const previousLive = previous.filter((entry) => entry.active !== 0)
	const previousById = new Map(previousLive.map((entry) => [entry.id, entry]))
	const previousByPath = new Map(previousLive.map((entry) => [entry.path, entry]))

	await volume.scan('/', async (path, stat) => {
		if (stat.type !== FileType.Regular) return
		if (path === LEGACY_DRAFT_PATH || path === SCRATCH_PATH) return
		if (!SHOW_HIDDEN_FOLDER && isHiddenPath(path)) return

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

// ── The host's slots ─────────────────────────────────────────────────────────
// Engine state — two cursors and this replica's id. It may not go in the replicated
// table (it is not the user's data) nor in the user's tree (the old engine's mistake),
// and `localStorage` is the one place this host has that is neither.
//
// None of it is keyed by user, because the replica it describes is not either: this app
// has opened one database for the whole browser since it shipped, and a per-user key
// over a shared store would only make the incoherence harder to see.

/** The old twin model's database, read once by the adoption pass and never written. */
const LEGACY_DB = 'justfiles-fs'
/** A store is a whole database here, named by the store's id. */
const STORE_DB = 'justfiles-store'
/** Where the one pass is recorded. Copy-then-swap, so re-running it costs a re-read —
 * but a pass that ran again after the volume was live would copy stale rows over live
 * ones, since rule 3 only makes an IDENTICAL row a no-op. */
const ADOPTED_KEY = 'justfiles-store-adopted'

type GetToken = () => Promise<string | null>

const slot = (key: string): CursorSlot => ({
	async load() {
		return localStorage.getItem(key) ?? undefined
	},
	async save(cursor) {
		if (cursor === undefined) localStorage.removeItem(key)
		else localStorage.setItem(key, cursor)
	}
})

// Stable across restarts, or the push filter stops recognising this replica's own work
// and every row it ever wrote is offered again.
function replicaId(): string {
	const held = localStorage.getItem('justfiles-replica')
	if (held) return held
	const minted = crypto.randomUUID()
	localStorage.setItem('justfiles-replica', minted)
	return minted
}

// The seam, over the wire. The token is minted per REQUEST — Clerk's expires — so it
// goes in through the injected `fetch` rather than a static header bag read once.
function remoteStore(getToken: GetToken): Store {
	return httpStore('/store', {
		fetch: async (url, init) => {
			const token = await getToken()
			return fetch(url, {
				...init,
				headers: {
					...(init?.headers as Record<string, string>),
					Authorization: `Bearer ${token ?? ''}`
				}
			})
		}
	})
}

export async function createVolumeRuntime(getToken: GetToken): Promise<VolumeRuntime> {
	const local = sharedStore(idbStore(STORE_DB), STORE_DB)
	if (!localStorage.getItem(ADOPTED_KEY)) {
		await migrateIdb(LEGACY_DB, local)
		localStorage.setItem(ADOPTED_KEY, '1')
	}
	const volume = await syncedVolume({
		local,
		remote: remoteStore(getToken),
		replica: replicaId(),
		pull: slot('justfiles-store-pull'),
		push: slot('justfiles-store-push'),
		lazyContent: true,
		localFirst: true
	})
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

	async function moveMemory(
		id: string,
		path: string,
		options?: { dedupe?: boolean }
	): Promise<string> {
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
			while (resolvedPath !== normalizedOldPath && (await volume.exists(resolvedPath))) {
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
		const bytes = new Uint8Array(await file.arrayBuffer())

		// The local store IS the working copy, so the write that lands here is the write
		// the preview renderer reads back — no remote round trip, and no dependence on
		// flush timing. The push carries it to the server on the next cycle, which the
		// commit itself arms.
		await volume.mkdir(assetDirPath(), { recursive: true })
		await volume.writeFile(assetPath, bytes)

		return assetPath
	}

	// Whether the asset EXISTS, said as the URL that would serve it. Every caller uses it
	// as a gate and then reads the bytes through `readAssetBlob`, so nothing fetches this
	// — but a URL that would not have worked is not an honest answer to give.
	async function resolveAssetUrl(notePath: string, src: string): Promise<string | null> {
		const resolvedPath = resolveRelativeFsPath(notePath, src)
		if (!resolvedPath) return src

		const stat = await volume.stat(resolvedPath).catch(() => null)
		if (!stat || stat.type !== FileType.Regular) return null

		return assetUrl(resolvedPath, stat.contentHash ?? stat.mtimeNs.toString())
	}

	async function readAssetBlob(notePath: string, src: string): Promise<Blob | null> {
		const resolvedPath = resolveRelativeFsPath(notePath, src)
		if (!resolvedPath) {
			const res = await fetch(src)
			if (!res.ok) return null
			return await res.blob()
		}

		// The synced volume reads through `hydratingBlobs`: a row this replica holds only
		// as a stub still reads, because the bytes are fetched from the peer on demand.
		// That is what the two remote fallbacks used to be for.
		const bytes = await volume.readFile(resolvedPath).catch(() => null)
		if (!bytes) return null
		return new Blob([bytes as BlobPart], { type: contentTypeOf(displayFilenameFromSrc(src)) })
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

function getOrCreateVolumeRuntime(userId: string, getToken: GetToken): Promise<VolumeRuntime> {
	const existing = runtimeSingletons.get(userId)
	if (existing) return existing

	const promise = createVolumeRuntime(getToken)
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
	const { getToken } = useAuth()
	const [runtime, setRuntime] = useState<VolumeRuntime | null>(null)

	useEffect(() => {
		let active = true
		getOrCreateVolumeRuntime(userId, getToken).then((r) => {
			if (active) setRuntime(r)
		})
		return () => {
			active = false
		}
	}, [userId, getToken])

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
