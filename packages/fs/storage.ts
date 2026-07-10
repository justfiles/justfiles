import type { JournalStore, PathMutationStore } from './sync-replica'
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
	/**
	 * Pin this mutation's outgoing path version to an EXACT value instead of the
	 * auto-incremented generator value (which also SETS the backend `path_version`,
	 * so it can move down as well as up). For applying a mutation at a known version
	 * — deterministic import/replay, and the test harness's concurrent-version
	 * staging. Omitted => the backend generates the next version.
	 */
	version?: number
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
	 * Full filesystem scan in parent-before-child order — the substrate for
	 * `volume.scan` (whole-tree walk). If absent the VFS walks via `listDirents`.
	 */
	fullScan?(cursor: string): Promise<{ entries: ScanEntry[]; next: string }>

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

	/**
	 * The write-intercept path journal (owned backends: SQLite + IDB). Appended in
	 * the same transaction as each mutation; feeds the path `ChangeSource` and the
	 * local `SyncReplica`. Absent on non-owned backends (native uses scan+diff).
	 */
	journal?: JournalStore

	/**
	 * The transactional path-apply seam used by `SyncReplica.applyPathChanges` on
	 * pull (owned backends). Installs tree metadata + `contentHash` ref + journal
	 * row (incoming version/origin verbatim) + `path_version` fast-forward in ONE
	 * txn; blob bytes are materialised out-of-band.
	 */
	pathApply?: PathMutationStore

	/**
	 * The backend's hash-addressed content store. Blobs are keyed by content hash
	 * (matching R2), so the inode holds a `contentHash` reference and the bytes live
	 * here. The local `SyncReplica.BlobStore` reads/writes it directly to materialise
	 * pulled content out-of-band and to hydrate lazy stubs; `getBlob` resolves an
	 * inode's bytes through it. A stored hash with no referencing path is a harmless
	 * orphan (GC reclaims it); a referenced hash with no blob is a lazy stub.
	 */
	content?: ContentStore

	/**
	 * Drop this replica's local sync state — the path journal + the per-path version
	 * generator (versions + tombstones) — WITHOUT touching the tree or content. Used
	 * by a client reset ("take theirs", docs/sync-reset-generation.md): after a
	 * server lineage reset, local version tombstones from deleting the old tree would
	 * outrank the re-pulled server puts (versions aren't comparable across lineages),
	 * so the discard must clear them for a clean re-bootstrap. Owned backends only.
	 */
	clearSyncState?(): Promise<void>
}

/** Hash-addressed content store (see `StorageCapabilities.content`). */
export interface ContentStore {
	getByHash(hash: string): Promise<Uint8Array | null>
	hasByHash(hash: string): Promise<boolean>
	/**
	 * Store `data` under `hash`. TRUSTS the caller — the backend does NOT verify
	 * `sha256(data) === hash`. The sync engine supplies a hash it already computed
	 * (re-hashing every pulled blob would be wasteful), so a lying caller corrupts
	 * the store: any non-sync caller MUST pass a hash computed from exactly these bytes.
	 */
	putByHash(hash: string, data: Uint8Array): Promise<void>
	/**
	 * Reclaim every stored blob that no inode's `contentHash` references. Out-of-band
	 * ONLY — NEVER call from the apply path: `applyJournaled` applies a rename's
	 * deletes before its puts, so a mid-apply sweep would drop bytes the same batch
	 * re-references. Returns the number of blobs reclaimed.
	 */
	gcUnreferenced(): Promise<number>
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
