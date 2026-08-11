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
	/** Opaque label for whoever caused this write; echoed on the change feed. */
	origin?: string
	/** Handed verbatim to the mutation observer. The filesystem never reads it. */
	observed?: unknown
}

/** Kind of change reported by the Storage change feed (see `subscribe`). */
export type StorageChangeKind = 'meta' | 'content' | 'dirent'

/**
 * A single committed mutation, reported to `subscribe` listeners.
 * - `meta`/`content`: the affected inode is `ino`.
 * - `dirent`: the entry `(dirIno, name)` was set or removed; `ino` is the
 *   entry's inode (the one bound, or the one that was bound before removal),
 *   and `path` is where it happened — the canonical path of the entry, so a
 *   listener can tell whether the change is inside a subtree it cares about
 *   (`volume.watch`'s recursive scoping) without a reverse ino→path walk. Every
 *   backend supplies it, except where the parent is already unlinked (nothing to
 *   name); an absent `path` means "unknown", so scoped listeners must assume the
 *   worst and fire.
 * `source` carries the `MutationOptions.origin` label the write was tagged with.
 */
export interface StorageChange {
	ino: Ino
	kind: StorageChangeKind
	source?: string
	dirIno?: Ino
	name?: string
	path?: string
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
	 *
	 * `content` is a regular file's COMPLETE bytes, and publishing them is part of
	 * the SAME atomic fact as taking the name: a concurrent reader that resolves
	 * the name observes all of `content`, or no name at all — never a name holding
	 * a prefix. Claiming the name first and filling it afterwards is what
	 * `Volume.writeFile`'s documented create atomicity forbids (#324): a reader
	 * cannot defend itself against a torn writer, because the intermediate states
	 * a torn writer exposes are not enumerable from the reader's side (empty, then
	 * a short prefix, then a prefix that happens to parse as a different value…).
	 *
	 * Staging the bytes is the BACKEND's job, never the VFS's (#323). A VFS that
	 * hashed and stored them first would commit a blob with zero inode references,
	 * and `content.gcUnreferenced()` reclaiming it there is that sweep doing its job
	 * correctly — the claim would then publish a `contentHash` pointing at nothing,
	 * which is the same failure by a different trigger. Only the backend can put the
	 * staging and the claim in one transaction, so only the backend does it. Where a
	 * hash is needed, compute it BEFORE opening the transaction: hashing commits
	 * nothing, so a claim lost afterwards must leave nothing behind.
	 *
	 * Every backend that declares `atomicCreate` MUST honour `content`, and
	 * `exclusive.test.ts` holds every local one to it. `apiStorage` is the one
	 * shipped case that cannot always be atomic about it — against a server whose
	 * own backend has no content store there is no atomic publish on that wire at
	 * all, so it negotiates and falls back to claim-then-fill, never losing the
	 * bytes (#331).
	 */
	atomicCreate?(
		dirIno: Ino,
		name: string,
		meta: InodeMeta,
		content?: Uint8Array,
		options?: MutationOptions
	): Promise<Ino>

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
	 * volume wrapper, because other writers can call Storage directly — a
	 * volume-level interceptor would miss those changes.
	 *
	 * Implementations must make this near-zero cost when there are no listeners.
	 * Returns an unsubscribe function.
	 */
	subscribe?(listener: (change: StorageChange) => void): () => void

	/**
	 * The backend's hash-addressed content store. Blobs are keyed by content hash
	 * (matching R2), so the inode holds a `contentHash` reference and the bytes live
	 * here. Other layers can read and write it directly to materialise content
	 * out-of-band and to hydrate lazy stubs; `getBlob` resolves an
	 * inode's bytes through it. A stored hash with no referencing path is a harmless
	 * orphan (GC reclaims it); a referenced hash with no blob is a lazy stub.
	 */
	content?: ContentStore
}

/** Hash-addressed content store (see `StorageCapabilities.content`). */
export interface ContentStore {
	getByHash(hash: string): Promise<Uint8Array | null>
	hasByHash(hash: string): Promise<boolean>
	/**
	 * Store `data` under `hash`. TRUSTS the caller — the backend does NOT verify
	 * `sha256(data) === hash`. A caller can supply a hash it already computed, so a
	 * lying caller corrupts the store. The hash must match these bytes.
	 */
	putByHash(hash: string, data: Uint8Array): Promise<void>
	/**
	 * Reclaim every stored blob that no inode's `contentHash` references. Run this
	 * only when no active batch can temporarily remove and then restore a reference.
	 *
	 * `done` is false when the operation ran out of its per-call budget with work
	 * left. The caller should call again. An unbounded backend always reports true.
	 */
	gcUnreferenced(): Promise<{ reclaimed: number; done: boolean }>
}

/**
 * Minimal storage backend — 9 pure K/V operations.
 *
 * Each method touches exactly one logical store (meta, blob, or dirents).
 * No nlink management, no cross-store side effects. The VFS owns sequencing.
 *
 * Hard links are not supported; steady state should have one directory entry
 * per inode. A move can still create a transient second name during
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
	 * This "upsert" behaviour lets a caller materialise an inode.
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
	 *
	 * Throws ENOENT if the inode is gone. It is not enough to skip the metadata update
	 * (which is what "silently" looked like): a caller that resolved a path a moment ago
	 * and is now writing its bytes has to hear that the file was removed underneath it,
	 * or it reports a save that stored nothing reachable. The check belongs in the same
	 * commit as the write — so it is the backend's, not the VFS's.
	 *
	 * The backend MUST update size and contentHash in metadata as a side effect,
	 * and MUST stamp `mtimeNs`/`ctimeNs` with the time of the write — in the same
	 * commit, so observers receive the new time. Callers that need an exact timestamp
	 * set it afterwards through `setMeta`.
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
