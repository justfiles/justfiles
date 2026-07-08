/**
 * The path-addressed sync boundary: `SyncReplica` (the full replica adapter),
 * `ChangeSource` (the journaling seam), and the backend seams the local adapter
 * composes over a lean `Storage` — `JournalStore` + `PathMutationStore`, plus the
 * native scan+diff seams.
 *
 * `Storage` stays the lean local-fs primitive (ino-keyed). This module owns the
 * *path* wire protocol; the local adapter wraps a `Storage`, the remote adapter
 * (in `@justfiles/core`) is the HTTP client to the `/fs` path endpoints.
 */

import type { Storage } from './storage'
import type { PathChange } from './sync-wire'
import { coalesceByPath } from './sync-wire'

/**
 * A cursor is an opaque, monotonically increasing position in one replica's
 * change stream: a SQLite/IDB journal `seq`, an NTFS USN, an FSEvents eventId,
 * or a Syncthing `sequence`. Compared only for ordering.
 */
export type SyncCursor = string

/** Local page size for delta/scan reads. */
export const PAGE = 500

// ── ChangeSource — how a replica reports what changed ─────────────────────────

/**
 * The journaling seam every backend implements. The sync engine calls ONLY these
 * two; it never learns the technique (write-intercept journal, OS change feed, or
 * scan+diff).
 */
export interface ChangeSource {
	/**
	 * Path-changes strictly after `cursor` (empty = from the start), ordered,
	 * capped at `limit`. `to` = cursor to persist; `done` = false if more pages
	 * remain. Deletes carry the removed path; a rename is delete(old) + put(new).
	 *
	 * TWO independent echo filters: `excludeOrigin` drops changes whose ORIGIN
	 * client-id (`PathChange.source`) matches — used by REMOTE pull to skip this
	 * client's own authored changes; `excludeLocalSource` drops rows whose LOCAL
	 * apply source matches (e.g. `REMOTE_SOURCE`) — used by LOCAL push to skip
	 * changes the sync layer itself applied from a pull. Both are needed.
	 */
	pathDeltas(
		cursor: SyncCursor,
		opts?: { excludeOrigin?: string; excludeLocalSource?: string; limit?: number }
	): Promise<{ changes: PathChange[]; to: SyncCursor; done: boolean }>

	/**
	 * A consistent full snapshot as `put`s (bootstrap). Returns BOTH a `next` page
	 * token (undefined when done) AND a `syncCursor` — the delta high-water frozen
	 * at snapshot START and echoed on every page, so after the final page the
	 * caller resumes `pathDeltas(syncCursor)` without gaps (idempotent overlap).
	 */
	pathScan(
		page?: SyncCursor,
		opts?: { limit?: number }
	): Promise<{ changes: PathChange[]; next?: SyncCursor; syncCursor: SyncCursor; done: boolean }>
}

// ── SyncReplica = composition of three orthogonal role interfaces ─────────────
// Not an inheritance hierarchy. `ChangeSource` (detection) has several concrete
// strategies (journaled | native | OS-feed) and can stand alone (a read-only
// change observer). A local replica COMPOSES an injected `ChangeSource` and adds
// `ChangeApplier` + `BlobStore` over its `Storage`; the remote HTTP replica
// implements all three facets inline. The three are split because they vary
// independently and straddle the source/target asymmetry: on push the SOURCE
// side needs `ChangeSource` + `BlobStore.get`, the TARGET side needs
// `ChangeApplier` + `BlobStore.put` — blobs belong to neither exclusively, hence
// their own role (content is address-by-hash, both directions).

/** Apply remote path-changes locally (the write/target side of a replica). */
export interface ChangeApplier {
	/**
	 * Apply remote changes locally. `opts.source` tags the LOCAL write (e.g.
	 * `REMOTE_SOURCE`) — it becomes the journal row's `localSource` for push
	 * suppression and drives `volume.watch`. Distinct from `PathChange.source`,
	 * the ORIGIN client-id used for pull-side `excludeOrigin` filtering.
	 *
	 * Content handling is explicit per replica (fixed at construction via
	 * `lazyContent`): EAGER fetches `getBlobByHash` now and stores it; LAZY writes
	 * a stub retaining `contentHash` and hydrates on first `readFile`.
	 */
	applyPathChanges(
		changes: PathChange[],
		getBlobByHash: (h: string) => Promise<Uint8Array>,
		opts?: { source?: string }
	): Promise<void>
}

/** Hash-addressed content transfer (both directions — R2 already is). */
export interface BlobStore {
	getBlobByHash(hash: string): Promise<Uint8Array>
	/** Local presence check (see Lazy content). */
	hasBlobByHash(hash: string): Promise<boolean>
	/**
	 * Store a blob in THIS replica's hash-addressed blob store. Local adapter:
	 * writes the backend content store (eager pull + lazy hydration). Remote
	 * adapter: PUT /fs/blob/:hash (push). Content is materialised HERE, never
	 * inside `applyJournaled`.
	 */
	putBlobByHash(hash: string, data: Uint8Array): Promise<void>
}

/**
 * The full replica: detection + apply + content, composed (not inherited). Local
 * (over a `Storage`/`Volume`, composing an injected `ChangeSource`) and remote
 * (HTTP client, implementing all facets inline) both satisfy it.
 */
export type SyncReplica = ChangeSource & ChangeApplier & BlobStore

// ── JournalStore — the owned-backend write-intercept journal ──────────────────

/**
 * A journal row = a `PathChange` plus its monotonic position, PLUS the local
 * apply source.
 * - `change.source` = ORIGIN client-id (cross-replica; travels the wire).
 * - `localSource`   = who applied this write LOCALLY (undefined for a user's own
 *   write; `REMOTE_SOURCE` when the sync layer applied it from a pull). Local-only.
 */
export interface JournalRow {
	seq: number
	change: PathChange
	localSource?: string
}

export interface JournalStore {
	/** Append rows within the mutation's own transaction. */
	append(changes: PathChange[], localSource?: string): Promise<void>
	/** Ordered by seq ascending, strictly after `seq`. */
	readFrom(seq: number, limit: number): Promise<JournalRow[]>
	/** Latest seq (snapshot resume). */
	head(): Promise<number>
}

/**
 * The transactional path-apply seam. Owned backends (SQLite + IDB) implement it
 * so the local `SyncReplica` can apply remote changes atomically without the
 * version generator clobbering the incoming version/origin. Touches ONLY the tree
 * + journal + version, NEVER blob bytes: it sets the inode metadata +
 * `contentHash` REFERENCE, appends the journal row with the incoming change
 * VERBATIM (its exact `version` and origin `source`) plus `localSource`, and sets
 * `path_version[path] = max(path_version[path], change.version)` (fast-forward
 * only). Content is materialised out-of-band by `applyPathChanges`.
 */
export interface PathMutationStore {
	applyJournaled(changes: PathChange[], opts: { localSource?: string }): Promise<void>
}

// ── Native (scan + diff) seams ────────────────────────────────────────────────

/** path -> last-agreed identity. Persisted (sidecar SQLite/LevelDB), NOT in-RAM. */
export interface NativeIndexRow {
	path: string
	contentHash: string
	mtimeNs: bigint
	size: bigint
	version: number // v1-bounded int; compared numerically
}

/** Persisted local index for the native scan+diff `ChangeSource`. */
export interface NativeIndex {
	get(path: string): Promise<NativeIndexRow | null>
	put(row: NativeIndexRow): Promise<void>
	delete(path: string): Promise<void>
	/** Iterate every indexed path (post-scan reconcile). */
	list(): Promise<NativeIndexRow[]>
}

/** The OS change feed the native detector consumes (FSEvents/inotify/USN). */
export interface FsWatcher {
	/** Candidate paths changed since `cursor`; `to` = latest eventId. */
	since(cursor: SyncCursor): Promise<{ paths: string[]; to: SyncCursor }>
	/** Latest eventId, captured at scan start. */
	head(): Promise<SyncCursor>
}

// ── Constructors (Phase 0: shape only, bodies throw) ──────────────────────────

/**
 * The `ChangeSource` for owned backends (SQLite + IDB): reads the write-intercept
 * `JournalStore` the backend exposes via `caps.journal`. The journal is intrinsic
 * to the store, so it is read from the store rather than passed separately.
 */
export function journaledChangeSource(store: Storage): ChangeSource {
	const requireJournal = (): JournalStore => {
		const journal = store.caps?.journal
		if (!journal) throw new Error('backend exposes no path journal (caps.journal)')
		return journal
	}
	return {
		async pathDeltas(cursor, opts) {
			const journal = requireJournal()
			const limit = opts?.limit ?? PAGE
			const rows = await journal.readFrom(Number(cursor || '0'), limit)
			// Two independent echo filters (see ChangeSource): origin client-id for
			// pull, local apply source for push. Both applied here; neither stalls the
			// cursor — `to` advances to the last RAW row so a fully-filtered page still
			// makes progress.
			const kept = rows.filter(
				(r) =>
					(!opts?.excludeOrigin || r.change.source !== opts.excludeOrigin) &&
					(!opts?.excludeLocalSource || r.localSource !== opts.excludeLocalSource)
			)
			const changes = coalesceByPath(kept.map((r) => r.change))
			return {
				changes,
				to: String(rows[rows.length - 1]?.seq ?? cursor ?? '0'),
				done: rows.length < limit
			}
		},
		async pathScan(_page, _opts) {
			// TODO(path-sync): freeze syncCursor=head() at start; walk tree as puts.
			throw new Error('not implemented')
		}
	}
}

/**
 * The native scan+diff `ChangeSource`: watch + scan `root`, diff against a
 * persisted `NativeIndex`, hash-cache by (path, mtimeNs, size).
 */
export function nativeChangeSource(
	_root: string,
	_index: NativeIndex,
	_watch: FsWatcher
): ChangeSource {
	return {
		async pathDeltas(_cursor, _opts) {
			// TODO(path-sync): stat candidates since cursor; emit put/delete vs index.
			throw new Error('not implemented')
		},
		async pathScan(_page, _opts) {
			// TODO(path-sync): full walk of root -> puts; syncCursor = watch.head().
			throw new Error('not implemented')
		}
	}
}

/**
 * The local `SyncReplica`, COMPOSED over a lean `Storage` + an INJECTED
 * `ChangeSource` (journaled for owned backends, native for scan+diff). It
 * delegates detection to `changes` and adds `ChangeApplier` + `BlobStore` over
 * the `Storage` (`caps.pathApply` + the content store). `lazyContent` fixes
 * eager vs lazy hydration; the `/.state/**` prefix is excluded here (hard path
 * rule) on top of the delegated `changes`.
 */
export function localSyncReplica(
	_storage: Storage,
	changes: ChangeSource,
	_opts: { lazyContent: boolean; localActorId: string }
): SyncReplica {
	return {
		async pathDeltas(cursor, opts) {
			// TODO(path-sync): drop /.state and /.state/** from the delegated changes.
			return changes.pathDeltas(cursor, opts)
		},
		async pathScan(page, opts) {
			// TODO(path-sync): drop /.state and /.state/** from the delegated changes.
			return changes.pathScan(page, opts)
		},
		async applyPathChanges(_changes, _getBlobByHash, _opts2) {
			// TODO(path-sync): refuse /.state/**; materialise blobs (eager) then
			// PathMutationStore.applyJournaled; resolve paths to inos (reuse/mint).
			throw new Error('not implemented')
		},
		async getBlobByHash(_hash) {
			// TODO(path-sync): read the hash-addressed content store.
			throw new Error('not implemented')
		},
		async hasBlobByHash(_hash) {
			// TODO(path-sync): local presence check against the content store.
			throw new Error('not implemented')
		},
		async putBlobByHash(_hash, _data) {
			// TODO(path-sync): write the hash-addressed content store.
			throw new Error('not implemented')
		}
	}
}

// ── Path-keyed sync state + tombstones (engine-internal, under /.state/sync) ──

/**
 * The engine's conflict-detection record, keyed by path — distinct from the
 * backend's `path_version` generator. Cannot live in inode xattrs (they vanish on
 * delete/recreate, which is exactly when tombstone detection matters).
 */
export type PathSyncState = {
	path: string
	baselineVersion: number // last version BOTH replicas agreed on at this path
	lastSeenHash?: string // last agreed content hash (undefined for dirs/symlinks)
	tombstoneVersion?: number // set when the path was deleted; survives recreate
}

/**
 * Sync engine state under `/.state/sync` (local-only per the `/.state/**`
 * exclusion). Forward-compat via the explicit `schemaVersion`, not the path name.
 */
export type SyncState = {
	schemaVersion: number // 1 for this design; future migrations branch on it
	pushCursor?: SyncCursor // over the local ChangeSource
	pullCursor?: SyncCursor // over the remote's ChangeSource
	// PathSyncState records are stored per-path under the same /.state/sync tree.
}

/** The `/.state/**` hard exclusion (local-only subtree; never crosses the wire). */
export function isLocalOnlyPath(p: string): boolean {
	return p === '/.state' || p.startsWith('/.state/')
}
