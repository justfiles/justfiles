import type { StorageBackend, InodeMeta } from './storage'
import type { Ino, Off, DirCursor, DirentMin } from './types'
import { FileType } from './types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FLUSH_DEBOUNCE_MS = 3_000
const DELTA_SYNC_INTERVAL_MS = 30_000
const RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 60_000]

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
	retryCount: number
	/** Earliest ms timestamp at which the next retry may run. */
	nextRetryAt: number
}

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
 * `remote` is the authoritative source of truth (e.g. `ApiStorageBackend`).
 *
 * Behaviour:
 *   - All inode allocation and directory operations go to `remote` immediately,
 *     because remote is the canonical inode namespace.
 *   - Content and xattr writes are written to `local` first (instant), then
 *     flushed to `remote` after `flushDebounceMs` of inactivity per inode.
 *   - Content reads check `local` first; on a miss (or after delta-sync
 *     invalidation) content is fetched from `remote` and stored in `local`.
 *   - Directory lookups are cached in-memory; every mutation updates the cache.
 *   - Inode metadata is cached in an in-memory map; on a miss the cache is
 *     populated from `remote`.
 *   - If `remote.changes` is implemented, a background delta sync runs every
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
	options?: { flushDebounceMs?: number },
): CachedStorageBackend {
	const flushDebounceMs = options?.flushDebounceMs ?? DEFAULT_FLUSH_DEBOUNCE_MS
	const rootIno = remote.rootIno

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
	/**
	 * Xattr names removed locally that must be propagated to remote on flush.
	 * Cleared per-inode after a successful flush.
	 */
	const deletedXattrs = new Map<Ino, Set<string>>()
	/**
	 * In-memory dir-lookup cache. Populated on read miss; invalidated on
	 * every directory mutation and cleared on delta sync.
	 * `null` values cache "not found" results.
	 */
	const dirCache = new Map<string, DirentMin | null>()

	let syncCursor = ''
	let paused = false
	let destroyed = false
	let deltaSyncTimer: ReturnType<typeof setInterval> | null = null

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

	// ---- Syncstate persistence ----------------------------------------------

	async function loadSyncState(): Promise<void> {
		try {
			const raw = await local.read(STATE_SYNCSTATE_INO, 0n, 512)
			if (raw.length === 0) return
			const obj = JSON.parse(new TextDecoder().decode(raw)) as { cursor?: unknown }
			if (typeof obj.cursor === 'string') syncCursor = obj.cursor
		} catch {
			// Corrupted or absent — start from beginning
		}
	}

	async function saveSyncState(): Promise<void> {
		try {
			const raw = new TextEncoder().encode(JSON.stringify({ cursor: syncCursor }))
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
				const ino = line.trim()
				if (!ino || isStatePath(ino) || dirty.has(ino)) continue
				dirty.set(ino, { retryCount: 0, nextRetryAt: 0 })
			}
		} catch {
			// Corrupted or absent — start empty
		}
	}

	async function saveDirtyState(): Promise<void> {
		try {
			const raw = new TextEncoder().encode(
				[...dirty.keys()]
					.filter((ino) => !isStatePath(ino))
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

	async function markDirty(ino: Ino): Promise<void> {
		const isNew = !dirty.has(ino)
		if (isNew) {
			dirty.set(ino, { retryCount: 0, nextRetryAt: 0 })
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

	async function flushIno(ino: Ino, force = false): Promise<void> {
		// Never sync reserved state inodes to remote.
		if (isStatePath(ino)) return

		const state = dirty.get(ino)
		if (!state) return
		// Honour backoff unless the caller explicitly forces a final attempt
		// (e.g. destroy() wants one last try regardless of retry schedule).
		if (!force && state.nextRetryAt > Date.now()) return

		try {
			// Read full content from local.
			// Use the cached size if available so we don't over-read.
			const cachedMeta = metaCache.get(ino)
			const readLen =
				cachedMeta !== undefined && cachedMeta.size > 0n
					? Number(cachedMeta.size)
					: MAX_READ_BYTES
			const data = await local.read(ino, 0n, readLen)

			// Push content to remote
			if (remote.putBlob) {
				await remote.putBlob(ino, data)
			} else {
				await remote.truncate(ino, 0n)
				if (data.length > 0) await remote.write(ino, 0n, data)
			}

			// Flush xattr deletions first so a remove-then-set sequence is safe.
			if (remote.removeXattr) {
				const deleted = deletedXattrs.get(ino)
				if (deleted) {
					for (const name of deleted) await remote.removeXattr!(ino, name)
				}
			}

			// Flush xattr additions/updates
			if (local.listXattr && local.getXattr && remote.setXattr) {
				const names = await local.listXattr(ino)
				for (const name of names) {
					const val = await local.getXattr!(ino, name)
					if (val) await remote.setXattr!(ino, name, val)
				}
			}

			dirty.delete(ino)
			await saveDirtyState()
			deletedXattrs.delete(ino)
			events.dispatchEvent(Object.assign(new Event('synced'), { ino }))
		} catch {
			// Exponential back-off — retry state lives in the dirty map entry
			const stateNow = dirty.get(ino)
			if (!stateNow) return // concurrently removed
			const idx = Math.min(stateNow.retryCount, RETRY_DELAYS_MS.length - 1)
			const delay = RETRY_DELAYS_MS[idx]!
			dirty.set(ino, {
				retryCount: stateNow.retryCount + 1,
				nextRetryAt: Date.now() + delay,
			})
			setTimeout(() => {
				if (!paused && !destroyed) void flushIno(ino)
			}, delay)
		}
	}

	async function flushAll(force = false): Promise<void> {
		await Promise.all([...dirty.keys()].map((ino) => flushIno(ino, force))
		)
	}

	// ---- Delta sync ---------------------------------------------------------

	async function runDeltaSync(): Promise<void> {
		if (paused || destroyed || !remote.changes) return
		try {
			const { inos, cursor } = await remote.changes(syncCursor)
			syncCursor = cursor
			await saveSyncState()

			let anyChange = false
			for (const ino of inos) {
				if (isStatePath(ino)) continue       // never process state paths
				if (dirty.has(ino)) continue         // local wins; do NOT overwrite
				metaCache.delete(ino)
				invalidated.add(ino)                 // force next read to bypass local
				anyChange = true
				events.dispatchEvent(Object.assign(new Event('change'), { ino }))
			}
			// Any remote change may have affected directory contents — clear the
			// entire dir cache conservatively (we don't know which dirs changed).
			if (anyChange) dirCache.clear()
		} catch {
			// Network error — keep last known cursor, retry on next interval
		}
	}

	function startDeltaSync(): void {
		if (deltaSyncTimer !== null || !remote.changes) return
		deltaSyncTimer = setInterval(() => {
			void runDeltaSync()
		}, DELTA_SYNC_INTERVAL_MS)
	}

	function stopDeltaSync(): void {
		if (deltaSyncTimer === null) return
		clearInterval(deltaSyncTimer)
		deltaSyncTimer = null
	}

	// Bootstrap: hydrate all local-only state before the first delta sync.
	void Promise.all([loadSyncState(), loadDirtyState()]).then(() => {
		startDeltaSync()
		void flushAll()
		void runDeltaSync()
	})

	// ---- Backend implementation ---------------------------------------------

	const backend: CachedStorageBackend = {
		events,
		rootIno,

		// --- Inode lifecycle (remote-authoritative) ---------------------------

		async alloc(meta) {
			const ino = await remote.alloc(meta)
			metaCache.set(ino, { ...meta, nlink: 0 })
			return ino
		},

		// --- Inode metadata ---------------------------------------------------

		async getMeta(ino) {
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
			const remoteMeta = await remote.getMeta(ino)
			if (remoteMeta) metaCache.set(ino, remoteMeta)
			return remoteMeta
		},

		async setMeta(ino, partial) {
			const current = metaCache.get(ino)
			if (current !== undefined) metaCache.set(ino, { ...current, ...partial })
			await local.setMeta(ino, partial)
		},

		// --- Extended attributes ---------------------------------------------

		async getXattr(ino, name) {
			if (local.getXattr) {
				const val = await local.getXattr(ino, name)
				if (val) return val
			}
			if (!remote.getXattr) return null
			const val = await remote.getXattr(ino, name)
			if (val && local.setXattr) await local.setXattr(ino, name, val)
			return val
		},

		async setXattr(ino, name, value) {
			if (local.setXattr) await local.setXattr(ino, name, value)
			// Un-tombstone if this name was previously removed in this session
			deletedXattrs.get(ino)?.delete(name)
			if (!isStatePath(ino) && !isStateDir(ino)) await markDirty(ino)
		},

		async listXattr(ino) {
			if (local.listXattr) {
				const names = await local.listXattr(ino)
				if (names.length > 0) return names
			}
			return remote.listXattr ? remote.listXattr(ino) : []
		},

		async removeXattr(ino, name) {
			if (local.removeXattr) await local.removeXattr(ino, name)
			// Track deletion so flush can propagate it to remote
			if (!deletedXattrs.has(ino)) deletedXattrs.set(ino, new Set())
			deletedXattrs.get(ino)!.add(name)
			if (!isStatePath(ino) && !isStateDir(ino)) await markDirty(ino)
		},

		// --- Data I/O --------------------------------------------------------

		async read(ino, offset: Off, length) {
			// Fast path: local hit (skip if this ino was invalidated by delta sync)
			if (!invalidated.has(ino)) {
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
			if (fullContent.length > 0) {
				// Populate local with the fresh content
				if (local.putBlob) {
					await local.putBlob(ino, fullContent)
				} else {
					await local.write(ino, 0n, fullContent)
				}
				const m = metaCache.get(ino)
				if (m !== undefined && m.size !== BigInt(fullContent.length)) {
					metaCache.set(ino, { ...m, size: BigInt(fullContent.length) })
				}
			} else {
				// Remote file is empty — explicitly evict any stale bytes in local
				// so the next read finds nothing there and returns empty correctly.
				await local.truncate(ino, 0n)
				const m = metaCache.get(ino)
				if (m !== undefined && m.size !== 0n) {
					metaCache.set(ino, { ...m, size: 0n })
				}
			}

			const start = Number(offset)
			return fullContent.slice(start, start + length)
		},

		async write(ino, offset: Off, data) {
			const n = await local.write(ino, offset, data)
			const end = offset + BigInt(data.length)
			const m = metaCache.get(ino)
			if (m !== undefined && end > m.size) metaCache.set(ino, { ...m, size: end })
			if (!isStatePath(ino) && !isStateDir(ino)) await markDirty(ino)
			return n
		},

		async truncate(ino, size: Off) {
			await local.truncate(ino, size)
			const m = metaCache.get(ino)
			if (m !== undefined) metaCache.set(ino, { ...m, size })
			if (!isStatePath(ino) && !isStateDir(ino)) await markDirty(ino)
		},

		async putBlob(ino, data) {
			if (local.putBlob) {
				await local.putBlob(ino, data)
			} else {
				await local.truncate(ino, 0n)
				if (data.length > 0) await local.write(ino, 0n, data)
			}
			const m = metaCache.get(ino)
			if (m !== undefined) metaCache.set(ino, { ...m, size: BigInt(data.length) })
			if (!isStatePath(ino) && !isStateDir(ino)) await markDirty(ino)
		},

		// --- Directory operations --------------------------------------------
		// Remote is the canonical inode namespace; local does not hold a
		// compatible directory structure, so dir entries are cached in-memory.

		async dirLookup(dirIno, name) {
			const stateEntry = lookupStateEntry(dirIno, name)
			if (stateEntry) return stateEntry
			const key = dirCacheKey(dirIno, name)
			if (dirCache.has(key)) return dirCache.get(key) ?? null
			const result = await remote.dirLookup(dirIno, name)
			dirCache.set(key, result)
			return result
		},

		async dirList(dirIno, cursor: DirCursor) {
			if (dirIno === STATE_DIR_INO) {
				return {
					entries: cursor === '' ? listStateEntries(dirIno) : [],
					next: '' as DirCursor,
				}
			}

			// Cursor-based pagination is too complex to cache reliably; go direct.
			const result = await remote.dirList(dirIno, cursor)
			if (dirIno !== rootIno || cursor !== '') return result

			return {
				entries: [
					...result.entries.filter((entry) => entry.name !== '.state'),
					...listStateEntries(dirIno),
				],
				next: result.next,
			}
		},

		async dirAdd(dirIno, name, ino, type) {
			const added = await remote.dirAdd(dirIno, name, ino, type)
			if (added) dirCache.set(dirCacheKey(dirIno, name), { ino, type })
			return added
		},

		async dirSet(dirIno, name, ino, type) {
			const displaced = await remote.dirSet(dirIno, name, ino, type)
			dirCache.set(dirCacheKey(dirIno, name), { ino, type })
			return displaced
		},

		async dirUnset(dirIno, name) {
			const removed = await remote.dirUnset(dirIno, name)
			dirCache.delete(dirCacheKey(dirIno, name))
			return removed
		},

		// --- Lifecycle -------------------------------------------------------

		async flush() {
			await flushAll()
		},

		pause() {
			paused = true
			stopDeltaSync()
		},

		resume() {
			paused = false
			startDeltaSync()
			void flushAll()
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
			const ino = await remote.create!(dirIno, name, meta)
			metaCache.set(ino, { ...meta, nlink: 1 })
			dirCache.set(dirCacheKey(dirIno, name), { ino, type: meta.type })
			return ino
		}
	}

	if (remote.rename) {
		backend.rename = async (oldDir, oldName, newDir, newName) => {
			const displaced = await remote.rename!(oldDir, oldName, newDir, newName)
			// Invalidate both source and destination entries
			dirCache.delete(dirCacheKey(oldDir, oldName))
			dirCache.delete(dirCacheKey(newDir, newName))
			return displaced
		}
	}

	if (remote.scan) {
		backend.scan = (cursor) => remote.scan!(cursor)
	}

	return backend
}
