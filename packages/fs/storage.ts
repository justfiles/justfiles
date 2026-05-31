import type { FileType, Ino } from './types'

export interface InodeMeta {
	type: FileType
	size: bigint
	mode: number
	mtimeNs: bigint
	ctimeNs: bigint
	contentHash?: string
	symlinkTarget?: string
	uid?: number
	gid?: number
}

export type MutationOptions = {
	source?: string
}

/** Kind of change reported by the Storage change feed (see `subscribe`). */
export type StorageChangeKind = 'meta' | 'content' | 'dirent'

/**
 * A single committed mutation, reported to `subscribe` listeners.
 * - `meta`/`content`: the affected inode is `ino`.
 * - `dirent`: the entry `(dirIno, name)` was set or removed; `ino` is the
 *   entry's inode (the one bound, or the one that was bound before removal).
 * `source` carries the `MutationOptions.source` the write was tagged with —
 * sync-applied writes are tagged so listeners can filter out remote echoes.
 */
export interface StorageChange {
	ino: Ino
	kind: StorageChangeKind
	source?: string
	dirIno?: Ino
	name?: string
}

export type UpdateQueryOptions = {
	source?: string
	sourceMode?: 'only' | 'exclude'
}

export type FsOp =
	| {
			kind: 'upsert-inode'
			source?: string
			ino: Ino
			meta?: Partial<InodeMeta>
			xattrs?: Record<string, Uint8Array | null>
	  }
	| {
			kind: 'set-dirent'
			source?: string
			dirIno: Ino
			name: string
			ino: Ino
			type: FileType
	  }
	| {
			kind: 'unset-dirent'
			source?: string
			dirIno: Ino
			name: string
			ino?: Ino
	  }

export class FsCursorExpiredError extends Error {
	constructor(message = 'FS sync cursor expired') {
		super(message)
		this.name = 'FsCursorExpiredError'
	}
}

export function isFsCursorExpiredError(error: unknown): error is FsCursorExpiredError {
	return (
		error instanceof FsCursorExpiredError ||
		(error instanceof Error && error.name === 'FsCursorExpiredError')
	)
}

export type ScanEntry = {
	ino: Ino
	dirIno: Ino
	name: string
	meta: InodeMeta
	xattrs?: Record<string, Uint8Array>
}

/**
 * Optional performance and feature capabilities that backends may declare.
 * Accessed via `backend.caps`.
 */
export interface StorageCapabilities {
	/**
	 * Atomic alloc + dirAdd in one operation — eliminates the orphaned-inode
	 * window between a bare setMeta + putDirent two-step.
	 * Returns the new ino. Throws EEXIST if name already exists in dirIno.
	 */
	atomicCreate?(dirIno: Ino, name: string, meta: InodeMeta, options?: MutationOptions): Promise<Ino>

	/**
	 * Atomic rename — moves a name from one directory to another without a
	 * window where both names exist. The backend handles freeing any displaced
	 * inode atomically. Returns the ino of the displaced entry (for cache
	 * invalidation), or null if nothing was displaced.
	 */
	atomicMove?(
		oldDir: Ino,
		oldName: string,
		newDir: Ino,
		newName: string,
		options?: MutationOptions
	): Promise<Ino | null>

	/** Partial read — if absent the VFS does a full getBlob. */
	readRange?(ino: Ino, offset: number, length: number): Promise<Uint8Array>

	/** Partial write — if absent the VFS does getBlob + modify + putBlob. */
	writeRange?(ino: Ino, offset: number, data: Uint8Array, options?: MutationOptions): Promise<void>

	/** Resize — if absent the VFS emulates via getBlob + slice + putBlob. */
	truncate?(ino: Ino, size: bigint, options?: MutationOptions): Promise<void>

	/** Extended attribute read. */
	getXattr?(ino: Ino, name: string): Promise<Uint8Array | null>

	/** Extended attribute write. */
	setXattr?(ino: Ino, name: string, value: Uint8Array, options?: MutationOptions): Promise<void>

	/** List all xattr names on an inode. */
	listXattrs?(ino: Ino): Promise<string[]>

	/** Remove a single xattr. */
	removeXattr?(ino: Ino, name: string, options?: MutationOptions): Promise<void>

	/**
	 * Full filesystem scan in parent-before-child order.
	 * `syncCursor` is the deltaUpdates cursor captured at scan time —
	 * callers store it as the starting point for subsequent incremental pulls.
	 */
	fullScan?(cursor: string): Promise<{ entries: ScanEntry[]; next: string; syncCursor?: string }>

	/**
	 * Return filesystem updates since the position encoded in `cursor`.
	 * Empty string means "from the beginning".
	 */
	deltaUpdates?(
		cursor: string,
		options?: UpdateQueryOptions
	): Promise<{ ops: FsOp[]; cursor: string }>

	/**
	 * Apply a batch of ops in a single round-trip — the sync push fast-path.
	 * `getBlob` supplies content for regular-file upserts so the implementation
	 * can inline bytes instead of fetching each blob separately. If absent, the
	 * sync layer falls back to applying ops one at a time. Callers must not rely
	 * on atomicity.
	 */
	applyBatch?(
		ops: FsOp[],
		getBlob: (ino: Ino) => Promise<Uint8Array>,
		options?: MutationOptions
	): Promise<void>

	/**
	 * Subscribe to a change feed of committed mutations — the substrate for
	 * `volume.watch`. The listener fires once per committed mutation entry point
	 * (`setMeta`/`putBlob`/`putDirent`/`deleteDirent`/`deleteInode` and the
	 * atomic caps), AFTER the write commits. Detection lives here, below the
	 * volume wrapper, because sync applies remote pulls straight to Storage —
	 * a volume-level interceptor would miss exactly those changes.
	 *
	 * Implementations must make this near-zero cost when there are no listeners.
	 * Returns an unsubscribe function.
	 */
	subscribe?(listener: (change: StorageChange) => void): () => void
}

/**
 * Minimal storage backend — 9 pure K/V operations.
 *
 * Each method touches exactly one logical store (meta, blob, or dirents).
 * No nlink management, no cross-store side effects. The VFS owns sequencing.
 *
 * Hard links are not supported; steady state should have one directory entry
 * per inode. Sync replay can still create a transient second name during
 * rename/move, so backends should treat deleteInode as a no-op while the inode
 * is still referenced by any dirent.
 *
 * Implement `caps` to opt into atomicity and performance features.
 */
export interface Storage {
	/** Backend-defined root inode — entry point for path resolution. */
	readonly rootIno: Ino

	/** Optional capability declarations. */
	readonly caps?: StorageCapabilities

	// ── Inode metadata ─────────────────────────────────────────────────────────

	/** Read all metadata for an inode. Returns null if not found. */
	getMeta(ino: Ino): Promise<InodeMeta | null>

	/**
	 * Partial update of metadata fields.
	 * If the inode does not exist AND patch contains enough fields to construct a
	 * full InodeMeta (type, size, mode, mtimeNs, ctimeNs), the inode is created.
	 * This "upsert" behaviour lets the sync layer materialise remote inodes.
	 */
	setMeta(ino: Ino, patch: Partial<InodeMeta>, options?: MutationOptions): Promise<void>

	/**
	 * Free an inode entirely — deletes metadata, blob data, and any xattrs.
	 * Backends should no-op if the inode is still referenced by any directory
	 * entry.
	 */
	deleteInode(ino: Ino): Promise<void>

	// ── Blob content ────────────────────────────────────────────────────────────

	/**
	 * Read the full content of an inode.
	 * Returns an empty Uint8Array if the inode has no content (new file, directory).
	 */
	getBlob(ino: Ino): Promise<Uint8Array>

	/**
	 * Replace the entire content of an inode atomically.
	 * The backend MUST update size and contentHash in metadata as a side effect.
	 */
	putBlob(ino: Ino, data: Uint8Array, options?: MutationOptions): Promise<void>

	// ── Directory entries ────────────────────────────────────────────────────────

	/** Look up a single name in a directory. Returns null if not found. */
	getDirent(dirIno: Ino, name: string): Promise<import('./types').DirentMin | null>

	/**
	 * Insert or replace a directory entry.
	 * Does NOT touch inode metadata — the VFS sequences this with setMeta/deleteInode.
	 */
	putDirent(
		dirIno: Ino,
		name: string,
		entry: import('./types').DirentMin,
		options?: MutationOptions
	): Promise<void>

	/**
	 * Remove a directory entry.
	 * Does NOT free the inode — the caller (VFS) calls deleteInode separately.
	 */
	deleteDirent(dirIno: Ino, name: string, options?: MutationOptions): Promise<void>

	/**
	 * List entries in a directory in batches.
	 * Empty-string cursor = start from beginning.
	 * Backend returns empty string next to signal end-of-directory.
	 */
	listDirents(
		dirIno: Ino,
		cursor: string
	): Promise<{
		entries: { name: string; ino: Ino; type: FileType }[]
		next: string
	}>
}
