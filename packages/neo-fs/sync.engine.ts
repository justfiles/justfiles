import type { Authority, EntityData, EntityId, Operation } from './sync.authority'
import type { Volume } from './volume'

/**
 * Open a replica without network access. Storage without STATE_DIR (sync.authority.ts) becomes a
 * fresh, uninitialized replica; entries already present stay untouched and invisible.
 * Managed storage replays its journal and finishes interrupted work before returning.
 * Saved state bound to a tree other than authority.root rejects with TREE_MISMATCH; storage leased
 * by another open engine rejects with LOCKED (ReplicaError). The engine holds the lease until close().
 * Synchronization, including the first bootstrap, runs only when the caller invokes sync().
 */
export declare function synced(props: SyncProps): Promise<SyncEngine>

interface SyncProps {
	/**
	 * The accepted tree at its root plus private state under STATE_DIR. Readers that bypass
	 * the engine see accepted files and that hidden directory, not pending work. Only the
	 * engine may write here while open; it generates and keeps the replica identity in STATE_DIR.
	 * The engine never touches entries it does not own: stray files, or a host's private
	 * directory placed inside storage, are never synced or removed. An incoming entity whose
	 * name such an entry occupies cannot install and is reported as an error issue.
	 * Must be one Store: detachment and journal publication rename entries between the root
	 * tree and STATE_DIR, and a rename that rejects with EXDEV cannot be recovered.
	 */
	storage: Volume

	/** Connection to the shared filesystem authority. */
	authority: Authority
}

/** Readers use local state only. Changing returned metadata or bytes does not change stored state. */
export interface SyncEngine {
	/**
	 * Accepted state with pending changes and local metadata applied to all filesystem operations.
	 * Authority state always installs. Local work the authority refuses is captured as a
	 * preserved version and removed from the view; nothing ever blocks catch-up.
	 * Writes persist under STATE_DIR. flush() does not wait for authority acceptance.
	 * Node IDs belong to this view and remain stable when pending entries become accepted.
	 * The root entry STATE_DIR is hidden: listings omit it, reads under it reject with ENOENT,
	 * and creating, renaming into, or removing it rejects with EPERM.
	 * Before the first bootstrap completes, every call rejects with UNINITIALIZED (ReplicaError).
	 * watch reports local writes once persisted. Installed authority changes and the removal of
	 * refused local work wake with source 'remote' after installation completes, never during a
	 * partial batch; the first bootstrap wakes the root recursively once.
	 * rm detaches: one update setting the entity's parent to null, for files and directories
	 * alike, leaving the subtree untouched. Detached subtrees live under STATE_DIR/trash by entity
	 * ID until the authority purges them; the engine may drop their bytes locally and refetch on
	 * restore. Browsing and restoring the trash are not exposed yet.
	 */
	readonly volume: Volume

	/** Report current activity and pending work without waiting for an active sync pass. */
	status(): Promise<SyncStatus>

	/** Current errors and preserved versions, including those from prior passes. Neither blocks synchronization. */
	issues(): Promise<SyncIssue[]>

	/** Return the preserved version, or null if the ID is not current. */
	conflict(id: string): Promise<Conflict | null>

	/**
	 * Release a preserved version and its retained bytes. Unknown IDs are a no-op.
	 * Restoring needs no engine operation: write the preserved version back through volume.
	 */
	dismiss(id: string): Promise<void>

	/**
	 * Exchange ready proposals and apply accepted changes in one pass.
	 * Bootstrap first when no authority cursor is installed or the authority requires it;
	 * an interrupted bootstrap resumes on the next pass. Completing it ends the uninitialized phase.
	 * Refused local work becomes a preserved version and never blocks later work.
	 * Concurrent calls serialize. Completion does not imply all pending work was accepted.
	 * Operational failures reject and appear in issues(); preserved versions appear without failing the pass.
	 */
	sync(): Promise<void>

	/**
	 * Finish local work, release the storage lease and other engine-owned resources,
	 * retaining pending changes. Does not wait for server acceptance or close the supplied dependencies.
	 */
	close(): Promise<void>
}

export type SyncStatus = {
	/** uninitialized: no bootstrap has completed yet; sync() performs it. */
	phase: 'uninitialized' | 'idle' | 'syncing' | 'closed'
	/** Local edits not yet retired, including acceptance awaiting catch-up. */
	pending: number
}

/**
 * error: an operation that failed and will be retried; cleared when it succeeds, replaced
 * under the same ID when it fails again. conflict: a local version that lost to the
 * authority, preserved for recovery until dismissed. Neither blocks synchronization.
 */
export type SyncIssue = { id: string; message: string } & (
	| { type: 'error'; code?: string }
	| { type: 'conflict' }
)

/**
 * A preserved version is immutable from capture and survives restarts until dismissed.
 * Later authority changes never alter or discard it.
 */
export type Conflict = Extract<SyncIssue, { type: 'conflict' }> & {
	/** The local operations that lost, including structural changes. */
	operations: Operation[]
	/** The state the local work started from, possibly including earlier edits; null means unknown. */
	base: ConflictSide | null
	/** The local version that lost. */
	local: ConflictSide
	/** The authority state that won, as installed at capture. */
	remote: ConflictSide
}

export interface ConflictSide {
	/**
	 * All sides cover the same affected entity IDs; null means absent on this side.
	 * Paths are absolute within the shared tree, and each node's ID matches its key.
	 */
	entries: StoredEntries

	/**
	 * Read this side's preserved file bytes by global ID, without contacting the authority.
	 * Missing entries, non-files, or missing/corrupt content reject. Returned bytes are detached.
	 * Readable only while the version is preserved and the engine is open.
	 */
	readFile(id: EntityId): Promise<Uint8Array>
}

/** A refused opening, a lost lease, or a volume call before the first bootstrap. */
export interface ReplicaError extends Error {
	readonly code: 'UNINITIALIZED' | 'TREE_MISMATCH' | 'LOCKED'
}

// biome-ignore lint/correctness/noUnusedVariables: Private persistence schema awaits the engine implementation.
type StoredConflict = {
	id: string
	message: string
	editIds: number[]
	base: StoredEntries | null
	local: StoredEntries
	remote: StoredEntries
}

type StoredEntries = Record<EntityId, { path: string; node: EntityData } | null>
