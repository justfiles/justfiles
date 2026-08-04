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

import type { ContentStore, Storage } from './storage'
import { incomingWins, orderForApply } from './storage.shared'
import type { PathChange } from './sync-wire'
import { coalesceByPath } from './sync-wire'
import { FileType } from './types'
import { volume } from './volume'

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
	): Promise<{ changes: PathChange[]; to: SyncCursor; done: boolean; generation?: number }>

	/**
	 * A consistent full snapshot as `put`s (bootstrap). Returns BOTH a `next` page
	 * token (undefined when done) AND a `syncCursor` — the delta high-water frozen
	 * at snapshot START and echoed on every page, so after the final page the
	 * caller resumes `pathDeltas(syncCursor)` without gaps (idempotent overlap).
	 *
	 * `generation` (client<->server only) is the server volume's lineage epoch,
	 * echoed on every page so `synced()` catches a reset mid-scan without a second
	 * handshake. Local/P2P sources leave it undefined.
	 */
	pathScan(
		page?: SyncCursor,
		opts?: { limit?: number }
	): Promise<{
		changes: PathChange[]
		next?: SyncCursor
		syncCursor: SyncCursor
		done: boolean
		generation?: number
	}>
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
	/** Batch presence check when the transport supports one. */
	missingBlobHashes?(hashes: string[]): Promise<Set<string>>
	/**
	 * Store a blob in THIS replica's hash-addressed blob store. Local adapter:
	 * writes the backend content store (eager pull + lazy hydration). Remote
	 * adapter: PUT /fs/blob/:hash (push). Content is materialised HERE, never
	 * inside `applyJournaled`.
	 */
	putBlobByHash(hash: string, data: Uint8Array): Promise<void>
}

/**
 * A lineage-mutation request. The wire shape is duplicated across the fs<->core
 * boundary on purpose (`packages/fs` must NOT import core; core validates its own
 * zod copy on the route). `wipe` is app-level (factory reset), so it is not here.
 */
export type ResetRequest =
	| { mode: 'adopt-mine'; fromGeneration: number; resetId: string; lineageId?: string }
	| { mode: 'complete'; resetId: string }

/**
 * Server-lineage coordination (`GET /fs` + `POST /fs/reset`) — read the epoch and
 * mutate it. Optional and remote-only: local/P2P replicas omit both (no server
 * lineage to report or reset).
 *
 * `handshake().generation` is the server volume's epoch, which `synced()` compares
 * against the stored one to detect a reset; `handshake().lineageId` is the volume's
 * stable identity, which `synced()` compares to detect a genuinely DIFFERENT volume
 * (a reused cursor bug the epoch alone can't catch); `resetId` is the advisory
 * "reset in progress" flag (not a lock — drives crash-resume identity and UI
 * legibility). `reset` mutates it: `adopt-mine` CASes on `fromGeneration` and returns
 * the new epoch; `complete` clears the advisory flag and returns nothing.
 */
export interface LineagePeer {
	handshake?(): Promise<{ generation?: number; resetId?: string; lineageId?: string }>
	reset?(body: ResetRequest): Promise<{ generation?: number }>
}

/**
 * The full replica: detection + apply + content, composed (not inherited). Local
 * (over a `Storage`/`Volume`, composing an injected `ChangeSource`) and remote
 * (HTTP client, implementing all facets inline) both satisfy it.
 */
export type SyncReplica = ChangeSource & ChangeApplier & BlobStore & LineagePeer

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
	/**
	 * Replace journal history with one locally-authored latest row per path so a
	 * re-bootstrap republishes current state, including unpushed tombstones.
	 * `dropDeletes` is safe only after "take mine" has emptied the target.
	 */
	adoptAllAsLocal(opts?: { dropDeletes?: boolean }): Promise<void>
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
 *
 * `localChange` is the LWW read side: the current local durable state at a path
 * (a `put` at its live version + meta, a `delete` at its tombstone version, or
 * `null` when the path was never touched here). `applyPathChanges` reads it
 * BEFORE applying so a lower-version (or digest-losing) incoming change never
 * clobbers a local winner.
 */
export interface PathMutationStore {
	localChange(path: string): Promise<PathChange | null>
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

// ── Constructors ──────────────────────────────────────────────────────────────

/**
 * Reconstruct a consistent snapshot from the journal, FROZEN at `head`: coalesce
 * every row with `seq <= head` into the latest state per path, keeping the live
 * puts (a path whose last op at/below head is a delete is gone). Deterministic
 * across calls — rows after `head` are ignored — so a paged bootstrap can keyset
 * paginate it and a mid-scan mutation surfaces only on the delta resume.
 */
async function snapshotPutsUpTo(journal: JournalStore, head: number): Promise<PathChange[]> {
	const rows: PathChange[] = []
	let cursor = 0
	while (cursor < head) {
		const batch = await journal.readFrom(cursor, PAGE)
		if (batch.length === 0) break
		for (const r of batch) {
			if (r.seq > head) break
			rows.push(r.change)
		}
		const last = batch[batch.length - 1]
		if (!last || last.seq >= head || batch.length < PAGE) break
		cursor = last.seq
	}
	return coalesceByPath(rows)
		.filter((c) => c.kind === 'put')
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

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
		async pathScan(page, opts) {
			const journal = requireJournal()
			const limit = opts?.limit ?? PAGE
			// Freeze the delta high-water at snapshot START and carry it (+ the page
			// key) in the opaque page token, so every page is cut at the SAME frozen
			// cursor. The returned `syncCursor` is just that frozen head (echoed on every
			// page); after the last page the caller resumes pathDeltas(syncCursor).
			let head: string
			let afterPath = ''
			if (page) {
				const i = page.indexOf(':')
				head = page.slice(0, i)
				const position = page.slice(i + 1)
				// Pre-keyset tokens used a numeric offset. Restart their frozen
				// snapshot because its old journal order cannot map to the new path order.
				if (!/^\d+$/.test(position)) afterPath = decodeURIComponent(position)
			} else {
				head = String(await journal.head())
			}
			const snapshot = await snapshotPutsUpTo(journal, Number(head))
			const remaining = afterPath ? snapshot.filter((change) => change.path > afterPath) : snapshot
			const changes = remaining.slice(0, limit)
			const lastPath = changes.at(-1)?.path
			const done = !lastPath || changes.length >= remaining.length
			const next = done ? undefined : `${head}:${encodeURIComponent(lastPath)}`
			return { changes, next, syncCursor: head, done }
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
 * eager vs lazy hydration; `ignore` marks paths this replica never sends, never
 * accepts and never sweeps — composed with the built-in private class, which it
 * cannot weaken (see `syncIgnore`).
 */
export function localSyncReplica(
	storage: Storage,
	changes: ChangeSource,
	opts: { lazyContent: boolean; localActorId: string; ignore?: (path: string) => boolean }
): SyncReplica {
	const isIgnored = syncIgnore(opts.ignore)
	// Only a CUSTOM ignore can be nested: the built-in class is top-level roots, and the
	// one path above those (`/`) is never replaced. So this whole check costs nothing
	// until a host declares its own.
	const nestedIgnorePossible = opts.ignore !== undefined
	const vol = volume(storage)

	/**
	 * Would applying `c` destroy a directory that currently holds an ignored path?
	 *
	 * A peer replacing `/state` with a regular file (or deleting it) is a legal change
	 * for the peer, but locally `/state/cache/**` is ignored and must survive — and a
	 * regular-file inode cannot hold dirents, so applying it would leave the preserved
	 * child attached to a file: unreachable, and a corrupt tree shape.
	 *
	 * The only coherent answer is to skip: the local tree keeps its directory and
	 * diverges from the peer at that path, which is what ignoring already means. It does
	 * not flap — skipping mutates nothing, so there is no new local change to push back.
	 */
	async function shieldsIgnored(c: PathChange): Promise<boolean> {
		if (!nestedIgnorePossible) return false
		if (c.kind === 'put' && c.meta.type === FileType.Directory) return false
		const st = await vol.lstat(c.path).catch(() => undefined)
		if (st?.type !== FileType.Directory) return false
		return hasIgnoredDescendant(c.path)
	}

	async function hasIgnoredDescendant(dir: string): Promise<boolean> {
		for (const e of await vol.readdir(dir).catch(() => [])) {
			const child = `${dir}/${e.name}`
			if (isIgnored(child)) return true
			if (e.type === FileType.Directory && (await hasIgnoredDescendant(child))) return true
		}
		return false
	}

	const requireContent = (): ContentStore => {
		const content = storage.caps?.content
		if (!content) throw new Error('backend exposes no content store (caps.content)')
		return content
	}
	const requirePathApply = (): PathMutationStore => {
		const pathApply = storage.caps?.pathApply
		if (!pathApply) throw new Error('backend exposes no path-apply seam (caps.pathApply)')
		return pathApply
	}
	return {
		async pathDeltas(cursor, opts) {
			// Hard exclusion (see syncIgnore): local-only state, credentials and this host's
			// own ignores never cross the wire, enforced here so a second volume(storage)
			// can't bypass it.
			const res = await changes.pathDeltas(cursor, opts)
			return { ...res, changes: res.changes.filter((c) => !isIgnored(c.path)) }
		},
		async pathScan(page, opts) {
			const res = await changes.pathScan(page, opts)
			return { ...res, changes: res.changes.filter((c) => !isIgnored(c.path)) }
		},
		async applyPathChanges(incoming, getBlobByHash, opts2) {
			// Hard exclusion (see syncIgnore): a peer can never inject local-only state or a
			// credential, enforced here so a second volume(storage) can't bypass it.
			// An ignored path only survives if its ANCESTORS do, so a change that would
			// replace or remove a directory holding one is dropped too (see shieldsIgnored).
			const admissible: PathChange[] = []
			for (const c of incoming)
				if (!isIgnored(c.path) && !(await shieldsIgnored(c))) admissible.push(c)
			const pathApply = requirePathApply()
			// Deterministic LWW against the CURRENT local state, read before applying:
			// keep only changes that beat their local path (numeric version, then a
			// source-independent digest tie-break). Without this, concurrent equal-
			// version writes swap (each side applies the other's last) instead of
			// converging to the SAME winner on both replicas.
			const winners: PathChange[] = []
			for (const c of coalesceByPath(admissible))
				if (await incomingWins(c, await pathApply.localChange(c.path))) winners.push(c)
			// Order the winners for safe apply: deletes child-before-parent (never orphan
			// a live child under a deleted dir), puts parent-before-child (the dir exists
			// before its entries), all deletes first.
			const ordered = orderForApply(winners)
			// Content ownership is out-of-band (blob store is hash-addressed, separate
			// from the tree). Eager: ensure each regular-file put's blob is present
			// locally BEFORE the tree references it (durable before the path points at
			// it). Lazy: skip the fetch — applyJournaled installs the contentHash stub
			// and readFile hydrates on first access.
			if (!opts.lazyContent) {
				const content = requireContent()
				for (const c of ordered) {
					if (c.kind !== 'put' || !c.contentHash) continue
					if (await content.hasByHash(c.contentHash)) continue
					await content.putByHash(c.contentHash, await getBlobByHash(c.contentHash))
				}
			}
			// One transactional seam per change: tree meta + contentHash ref + journal
			// row (incoming version/origin verbatim) + path_version fast-forward.
			await pathApply.applyJournaled(ordered, { localSource: opts2?.source })
		},
		async getBlobByHash(hash) {
			const blob = await requireContent().getByHash(hash)
			if (!blob) throw new Error(`ENOENT: blob ${hash}`)
			return blob
		},
		async hasBlobByHash(hash) {
			return requireContent().hasByHash(hash)
		},
		async putBlobByHash(hash, data) {
			await requireContent().putByHash(hash, data)
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
	generation?: number // server volume lineage this replica is synced against
	// The server volume's stable, unique identity this replica synced against. Distinct
	// from `generation` (an epoch counter seeded to 1 in every volume): when the observed
	// `lineageId` differs, the stored cursors were minted against a DIFFERENT volume, so
	// `synced()` client-resets and re-bootstraps instead of reusing them.
	lineageId?: string
	// In-flight "take mine" (adopt-mine), persisted BEFORE the reset CAS so a crash
	// mid-republish resumes/adopts instead of discarding the volume it meant to
	// publish. `fromGeneration` is the lineage the reset started from; `toGeneration`
	// is the one it produced, set once the reset is confirmed (also marks local prep done).
	pendingReset?: { resetId: string; fromGeneration: number; toGeneration?: number }
	pushCursor?: SyncCursor // over the local ChangeSource
	pullCursor?: SyncCursor // over the remote's ChangeSource
	// PathSyncState records are stored per-path under the same /.state/sync tree.
}

/**
 * Prefixes that never cross the wire, in EITHER direction:
 *   /.state  — this replica's own sync bookkeeping (engine-private, frozen)
 *   /private — everything this host keeps to ITSELF
 *
 * Named for ACCESSIBILITY, like an access modifier: nobody outside this replica may
 * have it. Ownership follows (the host that acquired a credential is the only one that
 * can read it), but reachability is the rule being enforced.
 *
 * `/private` is the GENERIC local-only lane, not the credential lane — credentials
 * were merely its first occupant. Two reasons a path belongs here, and the layout
 * separates them by subtree rather than by root:
 *
 *   /private/accounts, /private/connections — nobody else MAY have these. Secrets.
 *   /private/cache/**                       — nobody else NEEDS to: reconstructible
 *                                             from an upstream that can re-serve them
 *                                             (see `cachePath`). Freely evictable.
 *   /private/tmp/**                         — in flight, and about to be renamed away.
 *
 * The split matters for sweeps, not for sync: losing a cache is a refill, losing a
 * credential is a re-auth. It is the same split Apple draws INSIDE an app container
 * with `Library/Caches`, and for the same reason — one never-replicated boundary,
 * subdivided by what may be thrown away.
 *
 * A top-level ROOT, not a subtree of `/system`: a never-sync lane nested under a
 * synced tree dies with any `rm -r` of its ancestor (`clientReset` / `reconcileLocal`),
 * and `/system` is exactly the tree we merge across hosts.
 *
 * Kept as an enumerable LIST, not just a predicate, because three consumers outside
 * sync need to name these paths: the agent shell's deny-list (`paths.SECRET_PREFIXES`),
 * the server reset (which resolves them to inodes in SQL — and only ever walks the
 * SERVER's copy, which holds credentials alone, never a client's cache), and frieren's
 * profile-migration skip list.
 */
export const PRIVATE_PREFIXES = ['/.state', '/private'] as const

/**
 * Where a volume path's cached bytes live: `/private/cache` MIRRORS the volume's own
 * namespace, so `/private/cache/applications/x/gui.js` holds what would otherwise sit
 * at `/applications/x/gui.js`.
 *
 * The volume path stays the file's identity and the mapping is a string concat — no
 * index, no lookup table, and a missing file is just a missing file that the reader
 * refetches. Never applied to a path already under `/private`.
 */
export function cachePath(path: string): string {
	return `/private/cache${path}`
}

/**
 * A segment-aware prefix matcher — the primitive the built-in class and a host's own
 * `ignore` both use, so `/privateer` is a sibling of `/private`, not a child. Hand-rolling
 * `startsWith` is the classic way to get this wrong.
 */
export function ignorePrefixes(prefixes: readonly string[]): (path: string) => boolean {
	return (p) => prefixes.some((d) => p === d || p.startsWith(`${d}/`))
}

const isPrivatePath = ignorePrefixes(PRIVATE_PREFIXES)

/**
 * What a replica ignores: never sent, never accepted, and never swept by a reset —
 * the built-in private class, OR whatever else THIS host declines to replicate
 * (a native daemon's `.DS_Store`, a build cache, …).
 *
 * The built-in class is a FLOOR, not a default: composing by OR means a host's `ignore`
 * can only widen the boundary, so no caller — present or future — can make credentials
 * sync by passing the wrong thing (or by forgetting to include them). And it stays a
 * predicate in CODE rather than a `.syncignore` file, so an app, the agent's shell or a
 * peer's push cannot edit it (see #290 D2).
 */
export function syncIgnore(ignore?: (path: string) => boolean): (path: string) => boolean {
	return ignore === undefined ? isPrivatePath : (p) => isPrivatePath(p) || ignore(p)
}

/**
 * A mutating `/fs` write was fenced: the client's `x-fs-generation` no longer
 * matches the server's volume lineage (the server was reset). Thrown by the
 * remote replicas (`remoteSyncReplica` / `apiStorage`) on a `409
 * generation_stale`; `synced()` catches it and runs the client-reset policy.
 * Carries the server's current generation so the reset can adopt it directly.
 */
export class GenerationStaleError extends Error {
	readonly generation?: number
	constructor(generation?: number) {
		super('generation_stale')
		this.name = 'GenerationStaleError'
		this.generation = generation
	}
}

/**
 * A mutating `/fs` write was fenced by IDENTITY: the `x-fs-lineage` the client
 * stamped no longer matches the server volume's `lineageId`, even though the
 * `generation` epoch still matches (a different volume was recreated at the same
 * epoch). Distinct from `GenerationStaleError` because the generation-based
 * reconcile is a no-op here — `synced()` must reconcile IDENTITY (re-handshake +
 * `reconcileLineage`) to recover immediately rather than at the next poll.
 */
export class LineageStaleError extends Error {
	readonly lineageId?: string
	constructor(lineageId?: string) {
		super('lineage_stale')
		this.name = 'LineageStaleError'
		this.lineageId = lineageId
	}
}
