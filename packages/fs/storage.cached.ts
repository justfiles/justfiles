import type { StorageBackend, InodeMeta, FsOp } from './storage'
import type { Ino, Off, DirCursor, DirentMin } from './types'
import { FileType } from './types'
import { createExclusiveRunner, createKeyedExclusiveRunner } from './exclusive'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FLUSH_DEBOUNCE_MS = 3_000
const DELTA_SYNC_INTERVAL_MS = 30_000
const RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 60_000]
const MAX_LOCAL_CACHE_ENTRY_BYTES = 4 * 1024 * 1024

/**
 * Reserved inode key used to persist the last delta-sync cursor in the local
 * backend's content store.  Follows the `/.state/` convention so that
 * explicit guards in flush and delta sync apply to it automatically.
 */
const STATE_SYNCSTATE_INO: Ino = '/.state/syncstate'
const STATE_DIRTY_INOS_INO: Ino = '/.state/dirty'
const STATE_DIR_INO: Ino = '/.state'
const SYNTHETIC_STATE_DIR_META: InodeMeta = {
	type: FileType.Directory,
	size: 0n,
	mode: 0o700,
	nlink: 1,
	mtimeNs: 0n,
	ctimeNs: 0n,
}

/**
 * Returns true for any inode that belongs to the reserved `/.state/`
 * namespace.  These inodes are never flushed to remote and never emitted as
 * `'change'` events.
 */
function isStatePath(ino: Ino): boolean {
	return ino.startsWith('/.state/')
}

function isStateDir(ino: Ino): boolean {
	return ino === STATE_DIR_INO
}

/** Maximum bytes to read in one shot when pulling full content from remote. */
const MAX_READ_BYTES = 64 * 1024 * 1024 // 64 MB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DirtyState {
	mask: number
	retryCount: number
	/** Earliest ms timestamp at which the next retry may run. */
	nextRetryAt: number
}

const DIRTY_CONTENT = 1 << 0
const DIRTY_META = 1 << 1
const DIRTY_PATH = 1 << 2
const KNOWN_DIRTY_MASK = DIRTY_CONTENT | DIRTY_META | DIRTY_PATH
const LEGACY_DIRTY_MASK = DIRTY_CONTENT | DIRTY_META

/**
 * Extended interface returned by `cachedStorage()`. Callers may:
 *   - `flush()` — push all pending writes to remote immediately.
 *   - `destroy()` — best-effort flush, then cancel all timers.
 *   - `pause()` — suspend the flush loop and delta sync.
 *   - `resume()` — resume them and immediately flush all dirty inodes.
 *   - `events` — EventTarget that emits:
 *       'change' events (with `.ino` property) when remote changes are detected.
 *       'synced' events (with `.ino` property) when a dirty inode is flushed.
 */
export type CachedStorageBackend = StorageBackend & {
	flush(): Promise<void>
	destroy(): void
	pause(): void
	resume(): void
	readonly events: EventTarget
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Wraps two `StorageBackend` instances into a read-through / write-behind
 * coordinator.
 *
 * `local` is the fast, cheap backend (e.g. `IdbStorageBackend`).
 * `remote` is the sync peer / source for bootstrap and incremental updates
 * (e.g. `ApiStorageBackend`).
 *
 * Behaviour:
 *   - Local namespace + inode metadata become authoritative after the first
 *     bootstrap. Remote is then treated as the replication source / sink.
 *   - Content and xattr writes are written to `local` first (instant), then
 *     flushed to `remote` after `flushDebounceMs` of inactivity per inode.
 *   - Content reads check `local` first; on a miss (or after delta-sync
 *     invalidation) content is fetched from `remote` and stored in `local`.
 *   - The first startup performs a full remote namespace bootstrap into local
 *     before serving namespace reads.
 *   - Directory lookups are served from local plus an in-memory cache; every
 *     mutation updates the cache.
 *   - Inode metadata is read from local and cached in memory.
 *   - If `remote.updates` is implemented, a background delta sync runs every
 *     30 s to pick up remote changes, invalidate stale local content, and
 *     emit `'change'` events.
 *   - Inodes under `/.state/` are never flushed to remote and never emitted
 *     as `'change'` events.
 *   - The last delta-sync cursor is persisted to `local`'s content store under
 *     `/.state/syncstate` so it survives page reloads.
 *
 * Has zero browser globals — connectivity wiring is the caller's concern.
 */
export function cachedStorage(
	local: StorageBackend,
	remote: StorageBackend,
	options?: { flushDebounceMs?: number; clientId?: string },
): CachedStorageBackend {
	const flushDebounceMs = options?.flushDebounceMs ?? DEFAULT_FLUSH_DEBOUNCE_MS
	const clientId = options?.clientId ?? crypto.randomUUID()
	const remoteHydrationSource = `${clientId}:remote`
	const rootIno = remote.rootIno
	const localUpdates = local.updates?.bind(local)
	const localMutationOptions = { source: clientId }
	const remoteHydrationMutationOptions = { source: remoteHydrationSource }

	// ---- Shared state -------------------------------------------------------

	const events = new EventTarget()
	/** In-memory inode metadata cache — authoritative while dirty. */
	const metaCache = new Map<Ino, InodeMeta>()
	/** Inodes with content or xattr writes not yet flushed to remote. */
	const dirty = new Map<Ino, DirtyState>()
	/** Per-inode debounce timers for the write-behind flush. */
	const flushTimers = new Map<Ino, ReturnType<typeof setTimeout>>()
	/**
	 * Inodes whose local content was invalidated by delta sync. Reads bypass
	 * local and go straight to remote until a fresh fetch repopulates local.
	 */
	const invalidated = new Set<Ino>()
	/** Inodes too large to persist in the local content cache. */
	const uncached = new Set<Ino>()
	/**
	 * In-memory dir-lookup cache. Populated on read miss; invalidated on
	 * every directory mutation and cleared on delta sync.
	 * `null` values cache "not found" results.
	 */
	const dirCache = new Map<string, DirentMin | null>()

	let remoteSyncCursor = ''
	let localSyncCursor = ''
	let namespaceBootstrapped = false
	let paused = false
	let destroyed = false
	let deltaSyncTimer: ReturnType<typeof setInterval> | null = null
	const runFlushExclusive = createExclusiveRunner()
	const runDeltaSyncExclusive = createExclusiveRunner()
	const runSyncCycleExclusive = createExclusiveRunner()
	const runFlushInoExclusive = createKeyedExclusiveRunner<Ino>()

	// ---- Dir cache helpers --------------------------------------------------

	function dirCacheKey(dirIno: Ino, name: string): string {
		return `${dirIno}\x00${name}`
	}

	function lookupStateEntry(dirIno: Ino, name: string): DirentMin | null {
		if (dirIno === rootIno && name === '.state') {
			return { ino: STATE_DIR_INO, type: FileType.Directory }
		}
		if (dirIno === STATE_DIR_INO) {
			if (name === 'syncstate') return { ino: STATE_SYNCSTATE_INO, type: FileType.Regular }
			if (name === 'dirty') return { ino: STATE_DIRTY_INOS_INO, type: FileType.Regular }
		}
		return null
	}

	function listStateEntries(dirIno: Ino): Array<{ name: string; ino: Ino; type: FileType }> {
		if (dirIno === rootIno) {
			return [{ name: '.state', ino: STATE_DIR_INO, type: FileType.Directory }]
		}
		if (dirIno === STATE_DIR_INO) {
			return [
				{ name: 'dirty', ino: STATE_DIRTY_INOS_INO, type: FileType.Regular },
				{ name: 'syncstate', ino: STATE_SYNCSTATE_INO, type: FileType.Regular },
			]
		}
		return []
	}

	async function applyRemoteXattrToLocal(
		ino: Ino,
		name: string,
		value: Uint8Array | null,
		source?: string,
	): Promise<void> {
		if (value === null) {
			if (!local.removeXattr) return
			await local.removeXattr(ino, name, source ? { source } : undefined)
			return
		}

		if (!local.setXattr) return
		await local.setXattr(ino, name, value, source ? { source } : undefined)
	}

	// ---- Syncstate persistence ----------------------------------------------

	async function loadSyncState(): Promise<void> {
		try {
			const raw = await local.read(STATE_SYNCSTATE_INO, 0n, 512)
			if (raw.length === 0) return
			const obj = JSON.parse(new TextDecoder().decode(raw)) as {
				remoteCursor?: unknown
				localCursor?: unknown
				namespaceBootstrapped?: unknown
			}
			if (typeof obj.remoteCursor === 'string') remoteSyncCursor = obj.remoteCursor
			if (typeof obj.localCursor === 'string') localSyncCursor = obj.localCursor
			if (typeof obj.namespaceBootstrapped === 'boolean') {
				namespaceBootstrapped = obj.namespaceBootstrapped
			}
		} catch {
			// Corrupted or absent — start from beginning
		}
	}

	async function saveSyncState(): Promise<void> {
		try {
			const raw = new TextEncoder().encode(JSON.stringify({
				remoteCursor: remoteSyncCursor,
				localCursor: localSyncCursor,
				namespaceBootstrapped,
			}))
			if (local.putBlob) {
				await local.putBlob(STATE_SYNCSTATE_INO, raw)
				return
			}
			await local.truncate(STATE_SYNCSTATE_INO, 0n)
			if (raw.length > 0) await local.write(STATE_SYNCSTATE_INO, 0n, raw)
		} catch {
			// Best-effort; not fatal
		}
	}

	async function loadDirtyState(): Promise<void> {
		try {
			const raw = await local.read(STATE_DIRTY_INOS_INO, 0n, MAX_READ_BYTES)
			if (raw.length === 0) return

			const text = new TextDecoder().decode(raw)
			for (const line of text.split('\n')) {
				const trimmed = line.trim()
				if (!trimmed) continue

				const idx = trimmed.lastIndexOf(':')
				const ino = idx === -1 ? trimmed : trimmed.slice(0, idx)
				if (!ino || isStatePath(ino) || dirty.has(ino)) continue

				const parsedMask = idx === -1 ? LEGACY_DIRTY_MASK : Number.parseInt(trimmed.slice(idx + 1), 10)
				const mask =
					Number.isFinite(parsedMask) && parsedMask > 0
						? (parsedMask & KNOWN_DIRTY_MASK)
						: LEGACY_DIRTY_MASK
				dirty.set(ino, { mask, retryCount: 0, nextRetryAt: 0 })
			}
		} catch {
			// Corrupted or absent — start empty
		}
	}

	async function saveDirtyState(): Promise<void> {
		try {
			const raw = new TextEncoder().encode(
				[...dirty.entries()]
					.filter(([ino]) => !isStatePath(ino))
					.map(([ino, state]) => `${ino}:${state.mask}`)
					.join('\n'),
			)

			if (local.putBlob) {
				await local.putBlob(STATE_DIRTY_INOS_INO, raw)
				return
			}

			await local.truncate(STATE_DIRTY_INOS_INO, 0n)
			if (raw.length > 0) await local.write(STATE_DIRTY_INOS_INO, 0n, raw)
		} catch {
			// Best-effort; not fatal
		}
	}

	// ---- Dirty tracking + debounce ------------------------------------------

	async function markDirty(ino: Ino, mask: number): Promise<void> {
		const current = dirty.get(ino)
		if (!current) {
			dirty.set(ino, { mask, retryCount: 0, nextRetryAt: 0 })
			await saveDirtyState()
		} else if ((current.mask & mask) !== mask) {
			dirty.set(ino, { ...current, mask: current.mask | mask })
			await saveDirtyState()
		}
		// Reset the debounce timer
		const existing = flushTimers.get(ino)
		if (existing !== undefined) clearTimeout(existing)
		const t = setTimeout(() => {
			flushTimers.delete(ino)
			if (!paused && !destroyed) void flushIno(ino)
		}, flushDebounceMs)
		flushTimers.set(ino, t)
	}

	// ---- Flush loop ---------------------------------------------------------

	function touchedInosFromOps(ops: FsOp[]): Set<Ino> {
		const inos = new Set<Ino>()
		for (const op of ops) {
			switch (op.kind) {
				case 'upsert-inode':
					inos.add(op.ino)
					break
				case 'set-dirent':
					inos.add(op.dirIno)
					inos.add(op.ino)
					break
				case 'unset-dirent':
					inos.add(op.dirIno)
					if (op.ino) inos.add(op.ino)
					break
			}
		}
		return inos
	}

	function coalesceFlushOps(ops: FsOp[]): FsOp[] {
		const coalesced: FsOp[] = []
		const pendingUpserts = new Map<Ino, FsOp & { kind: 'upsert-inode' }>()

		function flushPendingUpserts(): void {
			if (pendingUpserts.size === 0) return
			for (const op of pendingUpserts.values()) {
				coalesced.push(op)
			}
			pendingUpserts.clear()
		}

		for (const op of ops) {
			if (op.kind !== 'upsert-inode') {
				flushPendingUpserts()
				coalesced.push(op)
				continue
			}

			const existing = pendingUpserts.get(op.ino)
			pendingUpserts.set(op.ino, {
				kind: 'upsert-inode',
				source: op.source ?? existing?.source,
				ino: op.ino,
				meta: op.meta ?? existing?.meta,
				xattrs:
					op.xattrs !== undefined || existing?.xattrs !== undefined
						? ({} as Record<string, Uint8Array | null>)
						: undefined,
				contentChanged: Boolean(existing?.contentChanged || op.contentChanged),
			})
		}

		flushPendingUpserts()
		return coalesced
	}

	function shouldFlushLocalOp(op: FsOp): boolean {
		return op.source === undefined || op.source === clientId
	}

	async function hydrateLocalDirent(
		dirIno: Ino,
		name: string,
		entry: DirentMin,
		source = remoteHydrationSource,
	): Promise<void> {
		const knownMeta = metaCache.get(entry.ino) ?? await local.getMeta(entry.ino)
		await local.dirSet(dirIno, name, entry.ino, entry.type, { source })
		if (knownMeta !== null && knownMeta !== undefined) {
			await local.setMeta(entry.ino, knownMeta, { source })
		}
		dirCache.set(dirCacheKey(dirIno, name), entry)
	}

	function shouldSkipRemoteDirOp(op: Extract<FsOp, { kind: 'set-dirent' | 'unset-dirent' }>): boolean {
		if (dirty.has(op.dirIno)) return true
		return op.ino !== undefined && dirty.has(op.ino)
	}

	type ScanEntry = {
		ino: Ino
		dirIno: Ino
		name: string
		type: FileType
		meta?: InodeMeta
		path: string
	}

	async function collectSnapshot(
		storage: StorageBackend,
		options?: { requireMeta?: boolean },
	): Promise<ScanEntry[]> {
		const requireMeta = options?.requireMeta ?? false

		if (storage.scan) {
			const entries: ScanEntry[] = []
			const inoToPath = new Map<Ino, string>([[rootIno, '/']])
			let cursor = ''
			do {
				const batch = await storage.scan(cursor)
				for (const entry of batch.entries) {
					const dirPath = inoToPath.get(entry.dirIno) ?? '/'
					const path = dirPath === '/' ? `/${entry.name}` : `${dirPath}/${entry.name}`
					inoToPath.set(entry.ino, path)
					entries.push({ ...entry, type: entry.meta.type, path })
				}
				cursor = batch.next
			} while (cursor !== '')
			return entries
		}

		const entries: ScanEntry[] = []
		async function walk(dirIno: Ino, dirPath: string): Promise<void> {
			let cursor = ''
			do {
				const batch = await storage.dirList(dirIno, cursor)
				for (const entry of batch.entries) {
					const meta = await storage.getMeta(entry.ino)
					if (meta === null && requireMeta) continue
					const path = dirPath === '/' ? `/${entry.name}` : `${dirPath}/${entry.name}`
					entries.push({ ...entry, meta: meta ?? undefined, path, dirIno })
					if (entry.type === FileType.Directory) {
						await walk(entry.ino, path)
					}
				}
				cursor = batch.next
			} while (cursor !== '')
		}

		await walk(rootIno, '/')
		return entries
	}

	async function bootstrapNamespace(): Promise<void> {
		const [rootMeta, remoteEntries, localEntries] = await Promise.all([
			remote.getMeta(rootIno),
			collectSnapshot(remote, { requireMeta: true }),
			collectSnapshot(local),
		])

		const remoteEntryKeys = new Set(remoteEntries.map((entry) => dirCacheKey(entry.dirIno, entry.name)))
		const remoteInos = new Set<Ino>([rootIno, ...remoteEntries.map((entry) => entry.ino)])

		dirCache.clear()

		for (const entry of localEntries.sort((left, right) => right.path.length - left.path.length)) {
			if (remoteEntryKeys.has(dirCacheKey(entry.dirIno, entry.name))) continue
			await local.dirUnset(entry.dirIno, entry.name, remoteHydrationMutationOptions)
			metaCache.delete(entry.ino)
			invalidated.delete(entry.ino)
			uncached.delete(entry.ino)
		}

		if (rootMeta !== null) {
			metaCache.set(rootIno, rootMeta)
			await local.setMeta(rootIno, rootMeta, remoteHydrationMutationOptions)
		}

		for (const entry of remoteEntries) {
			if (entry.meta === undefined) continue
			metaCache.set(entry.ino, entry.meta)
			await local.setMeta(entry.ino, entry.meta, remoteHydrationMutationOptions)
			await local.dirSet(entry.dirIno, entry.name, entry.ino, entry.type, remoteHydrationMutationOptions)
			dirCache.set(dirCacheKey(entry.dirIno, entry.name), { ino: entry.ino, type: entry.type })
		}

		for (const ino of [...metaCache.keys()]) {
			if (isStateDir(ino) || isStatePath(ino)) continue
			if (!remoteInos.has(ino)) metaCache.delete(ino)
		}

		namespaceBootstrapped = true
		await saveSyncState()
	}

	async function applyRemoteOp(op: FsOp): Promise<void> {
		switch (op.kind) {
			case 'upsert-inode': {
				if (isStatePath(op.ino) || isStateDir(op.ino)) return

				if (op.contentChanged) {
					const cachedMeta = metaCache.get(op.ino)
					const readLen =
						cachedMeta !== undefined && cachedMeta.size > 0n
							? Number(cachedMeta.size)
							: MAX_READ_BYTES
					const data = await local.read(op.ino, 0n, readLen)

					if (remote.putBlob) {
						await remote.putBlob(op.ino, data, op.source ? { source: op.source } : undefined)
					} else {
						await remote.truncate(op.ino, 0n, op.source ? { source: op.source } : undefined)
						if (data.length > 0) await remote.write(op.ino, 0n, data, op.source ? { source: op.source } : undefined)
					}
				}

				if (op.xattrs !== undefined) {
					const localNames = local.listXattr ? await local.listXattr(op.ino) : []
					const localNameSet = new Set(localNames)

					if (remote.removeXattr && remote.listXattr) {
						const remoteNames = await remote.listXattr(op.ino)
						for (const name of remoteNames) {
							if (!localNameSet.has(name)) await remote.removeXattr(op.ino, name, op.source ? { source: op.source } : undefined)
						}
					}

					if (local.getXattr && remote.setXattr) {
						for (const name of localNames) {
							const val = await local.getXattr(op.ino, name)
							if (val) await remote.setXattr(op.ino, name, val, op.source ? { source: op.source } : undefined)
						}
					}
				}

				if (op.meta && remote.setMeta) {
					await remote.setMeta(op.ino, {
						mode: op.meta.mode,
						mtimeNs: op.meta.mtimeNs,
						ctimeNs: op.meta.ctimeNs,
						symlinkTarget: op.meta.symlinkTarget,
					}, op.source ? { source: op.source } : undefined)
				}
				return
			}
			case 'set-dirent':
				if (isStateDir(op.dirIno) || isStatePath(op.dirIno)) return
				await remote.dirSet(op.dirIno, op.name, op.ino, op.type, op.source ? { source: op.source } : undefined)
				return
			case 'unset-dirent':
				if (isStateDir(op.dirIno) || isStatePath(op.dirIno)) return
				await remote.dirUnset(op.dirIno, op.name, op.source ? { source: op.source } : undefined)
				return
		}
	}

	async function flushPendingUpdates(): Promise<{ hadOps: boolean; touchedInos: Set<Ino> }> {
		return runFlushExclusive(async () => {
			if (!localUpdates) return { hadOps: false, touchedInos: new Set() }

			const { ops, cursor } = await localUpdates(localSyncCursor)
			const flushableOps = ops.filter(shouldFlushLocalOp)
			if (flushableOps.length === 0) {
				if (cursor !== localSyncCursor) {
					localSyncCursor = cursor
					await saveSyncState()
				}
				return { hadOps: false, touchedInos: new Set() }
			}

			const coalescedOps = coalesceFlushOps(flushableOps)
			for (const op of coalescedOps) {
				await applyRemoteOp(op)
			}

			localSyncCursor = cursor
			await saveSyncState()
			return { hadOps: true, touchedInos: touchedInosFromOps(coalescedOps) }
		})
	}

	async function flushIno(ino: Ino, force = false): Promise<void> {
		return runFlushInoExclusive(ino, async () => {
			// Never sync reserved state inodes to remote.
			if (isStatePath(ino)) return

			const state = dirty.get(ino)
			if (!state) return
			// Honour backoff unless the caller explicitly forces a final attempt
			// (e.g. destroy() wants one last try regardless of retry schedule).
			if (!force && state.nextRetryAt > Date.now()) return

			try {
				const { hadOps, touchedInos } = await flushPendingUpdates()
				if (hadOps) {
					for (const touchedIno of touchedInos) {
						if (dirty.delete(touchedIno)) {
							events.dispatchEvent(Object.assign(new Event('synced'), { ino: touchedIno }))
						}
					}
					if (touchedInos.size > 0) await saveDirtyState()
					return
				}
			} catch {
				// Exponential back-off — retry state lives in the dirty map entry
				const stateNow = dirty.get(ino)
				if (!stateNow) return // concurrently removed
				const idx = Math.min(stateNow.retryCount, RETRY_DELAYS_MS.length - 1)
				const delay = RETRY_DELAYS_MS[idx]!
				dirty.set(ino, {
					mask: stateNow.mask,
					retryCount: stateNow.retryCount + 1,
					nextRetryAt: Date.now() + delay,
				})
				setTimeout(() => {
					if (!paused && !destroyed) void flushIno(ino)
				}, delay)
			}
		})
	}

	async function flushAll(force = false): Promise<void> {
		await Promise.all([...dirty.keys()].map((ino) => flushIno(ino, force))
		)
	}

	// ---- Delta sync ---------------------------------------------------------

	function changedInosFromOps(ops: FsOp[]): Set<Ino> {
		const inos = new Set<Ino>()
		for (const op of ops) {
			switch (op.kind) {
				case 'upsert-inode':
					inos.add(op.ino)
					break
				case 'set-dirent':
					inos.add(op.ino)
					break
				case 'unset-dirent':
					if (op.ino) inos.add(op.ino)
					break
			}
		}
		return inos
	}

	async function runDeltaSync(): Promise<void> {
		return runDeltaSyncExclusive(async () => {
			if (paused || destroyed || !remote.updates || !namespaceBootstrapped) return
			try {
				const { ops, cursor } = await remote.updates(remoteSyncCursor, { source: clientId, sourceMode: 'exclude' })
				remoteSyncCursor = cursor
				await saveSyncState()

				if (ops.length === 0) return

				for (const op of ops) {
					switch (op.kind) {
						case 'upsert-inode':
							if (isStatePath(op.ino) || isStateDir(op.ino)) continue
							if (dirty.has(op.ino)) continue
							if (op.xattrs !== undefined) {
								for (const [name, value] of Object.entries(op.xattrs)) {
									await applyRemoteXattrToLocal(op.ino, name, value, op.source)
								}
							}
							if (op.meta) {
								metaCache.set(op.ino, op.meta)
								await local.setMeta(op.ino, op.meta, op.source ? { source: op.source } : undefined)
							} else {
								metaCache.delete(op.ino)
							}
							if (op.contentChanged) invalidated.add(op.ino)
							break
						case 'set-dirent':
							if (isStateDir(op.dirIno) || isStatePath(op.dirIno)) continue
							if (shouldSkipRemoteDirOp(op)) continue
							await hydrateLocalDirent(op.dirIno, op.name, { ino: op.ino, type: op.type }, op.source)
							break
						case 'unset-dirent':
							if (isStateDir(op.dirIno) || isStatePath(op.dirIno)) continue
							if (shouldSkipRemoteDirOp(op)) continue
							await local.dirUnset(op.dirIno, op.name, op.source ? { source: op.source } : undefined)
							dirCache.delete(dirCacheKey(op.dirIno, op.name))
							break
					}
				}

				const changedInos = changedInosFromOps(ops)
				for (const ino of changedInos) {
					if (isStatePath(ino) || isStateDir(ino)) continue // never process state paths
					if (dirty.has(ino)) continue // local wins; do NOT overwrite
					events.dispatchEvent(Object.assign(new Event('change'), { ino }))
				}
			} catch {
				// Network error — keep last known cursor, retry on next interval
			}
		})
	}

	async function runSyncCycle(): Promise<void> {
		return runSyncCycleExclusive(async () => {
			if (paused || destroyed) return

			await flushAll()
			if (dirty.size > 0) return

			if (!namespaceBootstrapped) {
				await bootstrapNamespace()
			}

			if (dirty.size > 0) return
			await runDeltaSync()
		})
	}

	function startDeltaSync(): void {
		if (deltaSyncTimer !== null) return
		deltaSyncTimer = setInterval(() => {
			void runSyncCycle()
		}, DELTA_SYNC_INTERVAL_MS)
	}

	function stopDeltaSync(): void {
		if (deltaSyncTimer === null) return
		clearInterval(deltaSyncTimer)
		deltaSyncTimer = null
	}

	const startupPromise = Promise.all([loadSyncState(), loadDirtyState()])
		.then(async () => {
			await runSyncCycle()
			startDeltaSync()
		})
		.catch(() => {
			startDeltaSync()
		})

	async function waitForStartup(): Promise<void> {
		await startupPromise
	}

	// ---- Backend implementation ---------------------------------------------

	const backend: CachedStorageBackend = {
		events,
		rootIno,

		// --- Inode lifecycle (remote-authoritative) ---------------------------

		async alloc(meta) {
			await waitForStartup()
			const ino = await remote.alloc(meta, localMutationOptions)
			const localMeta: InodeMeta = { ...meta, nlink: 0 }
			metaCache.set(ino, localMeta)
			await local.setMeta(ino, localMeta, remoteHydrationMutationOptions)
			return ino
		},

		// --- Inode metadata ---------------------------------------------------

		async getMeta(ino) {
			await waitForStartup()
			if (isStateDir(ino)) return { ...SYNTHETIC_STATE_DIR_META }
			if (isStatePath(ino)) {
				const raw = await local.read(ino, 0n, MAX_READ_BYTES)
				return {
					type: FileType.Regular,
					size: BigInt(raw.length),
					mode: 0o600,
					nlink: 1,
					mtimeNs: 0n,
					ctimeNs: 0n,
				}
			}
			const cached = metaCache.get(ino)
			if (cached !== undefined) return { ...cached }
			const localMeta = await local.getMeta(ino)
			if (localMeta !== null) {
				metaCache.set(ino, localMeta)
				return { ...localMeta }
			}
			return null
		},

		async setMeta(ino, partial) {
			await waitForStartup()
			const current = metaCache.get(ino)
			if (current !== undefined) metaCache.set(ino, { ...current, ...partial })
			await local.setMeta(ino, partial, localMutationOptions)
		},

		// --- Extended attributes ---------------------------------------------

		async getXattr(ino, name) {
			await waitForStartup()
			if (local.getXattr) {
				const val = await local.getXattr(ino, name)
				if (val) return val
			}
			if (!remote.getXattr) return null
			const val = await remote.getXattr(ino, name)
			if (val) await applyRemoteXattrToLocal(ino, name, val, remoteHydrationSource)
			return val
		},

		async setXattr(ino, name, value) {
			await waitForStartup()
			if (local.setXattr) await local.setXattr(ino, name, value, localMutationOptions)
			if (!isStatePath(ino) && !isStateDir(ino)) await markDirty(ino, DIRTY_META)
		},

		async listXattr(ino) {
			await waitForStartup()
			if (local.listXattr) {
				const names = await local.listXattr(ino)
				if (names.length > 0) return names
			}
			return remote.listXattr ? remote.listXattr(ino) : []
		},

		async removeXattr(ino, name) {
			await waitForStartup()
			if (local.removeXattr) await local.removeXattr(ino, name, localMutationOptions)
			if (!isStatePath(ino) && !isStateDir(ino)) await markDirty(ino, DIRTY_META)
		},

		// --- Data I/O --------------------------------------------------------

		async read(ino, offset: Off, length) {
			await waitForStartup()
			// Fast path: local hit (skip if this ino was invalidated by delta sync)
			if (!invalidated.has(ino) && !uncached.has(ino)) {
				const localData = await local.read(ino, offset, length)
				if (localData.length > 0) return localData

				// Genuine empty file — return early without hitting remote
				const meta = metaCache.get(ino)
				if (meta !== undefined && meta.size === 0n) return new Uint8Array()
			}

			// Cache miss or delta-sync invalidation: pull full content from remote
			const fullContent = await remote.read(ino, 0n, MAX_READ_BYTES)
			// Always clear the invalidation flag after a successful remote fetch,
			// regardless of content length.
			invalidated.delete(ino)
			if (fullContent.length > MAX_LOCAL_CACHE_ENTRY_BYTES) {
				uncached.add(ino)
			} else if (fullContent.length > 0) {
				uncached.delete(ino)
				// Populate local with the fresh content
					if (local.putBlob) {
						await local.putBlob(ino, fullContent, remoteHydrationMutationOptions)
					} else {
						await local.write(ino, 0n, fullContent, remoteHydrationMutationOptions)
					}
				const m = metaCache.get(ino)
				if (m !== undefined && m.size !== BigInt(fullContent.length)) {
					metaCache.set(ino, { ...m, size: BigInt(fullContent.length) })
				}
			} else {
				uncached.delete(ino)
				// Remote file is empty — explicitly evict any stale bytes in local
				// so the next read finds nothing there and returns empty correctly.
				await local.truncate(ino, 0n, remoteHydrationMutationOptions)
				const m = metaCache.get(ino)
				if (m !== undefined && m.size !== 0n) {
					metaCache.set(ino, { ...m, size: 0n })
				}
			}

			const start = Number(offset)
			return fullContent.slice(start, start + length)
		},

		async write(ino, offset: Off, data) {
			await waitForStartup()
			uncached.delete(ino)
			const n = await local.write(ino, offset, data, localMutationOptions)
			const end = offset + BigInt(data.length)
			const m = metaCache.get(ino)
			if (m !== undefined && end > m.size) metaCache.set(ino, { ...m, size: end })
			if (!isStatePath(ino) && !isStateDir(ino)) await markDirty(ino, DIRTY_CONTENT)
			return n
		},

		async truncate(ino, size: Off) {
			await waitForStartup()
			if (size === 0n) uncached.delete(ino)
			await local.truncate(ino, size, localMutationOptions)
			const m = metaCache.get(ino)
			if (m !== undefined) metaCache.set(ino, { ...m, size })
			if (!isStatePath(ino) && !isStateDir(ino)) await markDirty(ino, DIRTY_CONTENT)
		},

		async putBlob(ino, data) {
			await waitForStartup()
			uncached.delete(ino)
			if (local.putBlob) {
				await local.putBlob(ino, data, localMutationOptions)
			} else {
				await local.truncate(ino, 0n, localMutationOptions)
				if (data.length > 0) await local.write(ino, 0n, data, localMutationOptions)
			}
			const m = metaCache.get(ino)
			if (m !== undefined) metaCache.set(ino, { ...m, size: BigInt(data.length) })
			if (!isStatePath(ino) && !isStateDir(ino)) await markDirty(ino, DIRTY_CONTENT)
		},

		// --- Directory operations --------------------------------------------

		async dirLookup(dirIno, name) {
			await waitForStartup()
			const stateEntry = lookupStateEntry(dirIno, name)
			if (stateEntry) return stateEntry
			const key = dirCacheKey(dirIno, name)
			if (dirCache.has(key)) return dirCache.get(key) ?? null
			const localResult = await local.dirLookup(dirIno, name)
			dirCache.set(key, localResult)
			return localResult
		},

		async dirList(dirIno, cursor: DirCursor) {
			await waitForStartup()
			if (dirIno === STATE_DIR_INO) {
				return {
					entries: cursor === '' ? listStateEntries(dirIno) : [],
					next: '' as DirCursor,
				}
			}

			const result = await local.dirList(dirIno, cursor)
			if (dirIno !== rootIno || cursor !== '') return result

			return {
				entries: [...result.entries.filter((entry) => entry.name !== '.state'), ...listStateEntries(dirIno)],
				next: result.next,
			}
		},

		async dirAdd(dirIno, name, ino, type) {
			await waitForStartup()
			const added = await local.dirAdd(dirIno, name, ino, type, localMutationOptions)
			if (added) dirCache.set(dirCacheKey(dirIno, name), { ino, type })
			if (added && !isStateDir(dirIno) && !isStatePath(dirIno)) {
				await Promise.all([
					markDirty(dirIno, DIRTY_PATH),
					markDirty(ino, DIRTY_PATH),
				])
			}
			return added
		},

		async dirSet(dirIno, name, ino, type) {
			await waitForStartup()
			const displaced = await local.dirSet(dirIno, name, ino, type, localMutationOptions)
			dirCache.set(dirCacheKey(dirIno, name), { ino, type })
			if (!isStateDir(dirIno) && !isStatePath(dirIno)) {
				const dirtyInos = [markDirty(dirIno, DIRTY_PATH), markDirty(ino, DIRTY_PATH)]
				if (displaced !== null) dirtyInos.push(markDirty(displaced.ino, DIRTY_PATH))
				await Promise.all(dirtyInos)
			}
			return displaced
		},

		async dirUnset(dirIno, name) {
			await waitForStartup()
			const removed = await local.dirUnset(dirIno, name, localMutationOptions)
			dirCache.delete(dirCacheKey(dirIno, name))
			if (removed !== null && !isStateDir(dirIno) && !isStatePath(dirIno)) {
				await Promise.all([
					markDirty(dirIno, DIRTY_PATH),
					markDirty(removed.ino, DIRTY_PATH),
				])
			}
			return removed
		},

		// --- Lifecycle -------------------------------------------------------

		async flush() {
			await waitForStartup()
			await flushAll()
		},

		pause() {
			paused = true
			stopDeltaSync()
		},

		resume() {
			paused = false
			startDeltaSync()
			void runSyncCycle()
		},

		destroy() {
			stopDeltaSync()
			destroyed = true
			for (const t of flushTimers.values()) clearTimeout(t)
			flushTimers.clear()
			// Best-effort flush — fire without awaiting so destroy() stays sync.
			// force=true bypasses the retry-backoff gate so inodes that previously
			// failed and are waiting in backoff still get one last attempt.
			// flushIno() itself does not check `destroyed`, so the attempt runs;
			// only future retry timers are suppressed by the destroyed flag.
			void flushAll(true)
		},
	}

	// Optional methods: wire from remote if present

	if (remote.create) {
		backend.create = async (dirIno, name, meta) => {
			await waitForStartup()
			const ino = await remote.create!(dirIno, name, meta, localMutationOptions)
			const localMeta: InodeMeta = { ...meta, nlink: 1 }
			metaCache.set(ino, localMeta)
			await local.setMeta(ino, localMeta, remoteHydrationMutationOptions)
			await hydrateLocalDirent(dirIno, name, { ino, type: meta.type })
			await local.setMeta(ino, localMeta, remoteHydrationMutationOptions)
			dirCache.set(dirCacheKey(dirIno, name), { ino, type: meta.type })
			return ino
		}
	}

	backend.rename = async (oldDir, oldName, newDir, newName) => {
		await waitForStartup()
		if (oldDir === newDir && oldName === newName) return null

		const source = await backend.dirLookup(oldDir, oldName)
		if (source === null) throw new Error(`ENOENT: ${oldName}`)

		const destination = await backend.dirLookup(newDir, newName)
		if (destination !== null && destination.ino === source.ino) {
			dirCache.set(dirCacheKey(oldDir, oldName), source)
			dirCache.set(dirCacheKey(newDir, newName), source)
			return null
		}

		const displaced = await local.dirSet(newDir, newName, source.ino, source.type, localMutationOptions)
		await local.dirUnset(oldDir, oldName, localMutationOptions)
		dirCache.delete(dirCacheKey(oldDir, oldName))
		dirCache.set(dirCacheKey(newDir, newName), source)
		await Promise.all([
			markDirty(oldDir, DIRTY_PATH),
			markDirty(newDir, DIRTY_PATH),
			markDirty(source.ino, DIRTY_PATH),
			...(displaced !== null ? [markDirty(displaced.ino, DIRTY_PATH)] : []),
		])
		return displaced?.ino ?? null
	}

	return backend
}
