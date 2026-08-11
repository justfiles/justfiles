/**
 * Pure path-sync rules shared by every owned backend (mem, SQLite/DO, IDB).
 *
 * These are the nuanced, bug-prone decisions — version generation, tombstone
 * fast-forward, the regular-file `contentHash` rule, wire construction, and the
 * child-before-parent / parent-before-child ordering — extracted as PURE
 * functions so they are written once, tested directly, and SHIP in every
 * backend (rather than living only in the `memStorage` test double).
 *
 * Deliberately minimal: the PURE leaf rules are free functions, and the apply
 * ORCHESTRATION (`applyJournaledOver` / `localChangeOver` / `journalPutOver` /
 * `journalDeleteOver`) runs over a tiny per-backend `TreePort` plus a sync-owned
 * `PathSyncStore`. Each backend still owns its storage access and atomicity; the port is the
 * storage-independent seam the shared driver needs (a Map walk vs a recursive
 * SQL CTE vs an IDB cursor behind one signature). See PATH-SYNC ROADMAP item 2
 * below.
 *
 * `pathSyncObserver` is the LOCAL half of that: the backends no longer journal,
 * they announce a `TreeEffect` and this module decides what to record. See
 * ROADMAP item 3 (#454).
 */

import type { InodeMeta, MutationOptions, StorageChange } from './storage'
import type { PathChange } from './sync-wire'
import {
	changeDigest,
	compareVersion,
	encodeVersion,
	inodeMetaFromSync,
	syncMetaFromInode
} from './sync-wire'
import type { DirentMin, Ino } from './types'
import { FileType } from './types'

// ── PATH-SYNC ROADMAP (ordered; post-SQLite epic) ─────────────────────────────
//
// SQLite is the first fully-proven owned backend (conformance 5/5). The work
// below is QUEUED in dependency order — do it top-to-bottom, each a separate
// commit / small epic. Recorded HERE (the shared center every backend imports)
// so the plan survives session breaks. Grep `TODO(path-sync)`.
//
//   1. [DONE 799cac9c] REMOVE THE LEGACY FsOp DELTA PROTOCOL. It had no
//      production consumer — `synced()` (path-sync) is the live driver in the
//      frieren + worker apps, and mem never even implemented it. Deleted:
//      caps.deltaUpdates + caps.applyBatch (storage.ts + sqlite/idb impls),
//      FsOp / UpdateQueryOptions / encodeOp, the fs_updates table + appendOps +
//      pruneUpdates (and their per-mutation call sites), the /delta + /ops routes
//      in fs.ts, and fs.client's deltaUpdates/applyBatch. KEPT caps.fullScan
//      (volume.scan tree-walk needs entries/next) but dropped its sync-only
//      `syncCursor` field. IDB dropped its 'updates' store (DB_VERSION 3->4);
//      SQLite dropped fs_updates + fs_state via 0003_drop_legacy_delta.sql.
//
//   2a. [DONE d5f1d5b9] EXTRACT THE SHARED APPLY DRIVER. applyJournaled /
//      localChange / per-mutation journaling were IDENTICAL control flow in mem +
//      sqlite, differing only in storage-primitive access, txn wrapping, and emit
//      timing. The orchestration now lives ONCE here (`applyJournaledOver` /
//      `localChangeOver` / `journalPutOver` / `journalDeleteOver`), driven through
//      the per-backend `TreePort` (below). mem + sqlite were retrofitted and
//      stay green (sqlite conformance 5/5). pathOf / resolveIno-walk /
//      ensureDirPath / enumerateSubtree stay per-backend (Map-walk vs recursive
//      CTE) — they cannot be shared. NOTE: the port was shaped from mem + sqlite
//      only; idb (2b) is the third impl that VALIDATES it — reshape the port there
//      if idb needs it (mem + sqlite conformance guard against regressions).
//      STILL TODO (micro): set ctime = nowNs() at apply (currently 0n in each
//      backend's port.upsertInode) — ctime is a local attr, never compared
//      for convergence; deferred to keep 2a a pure refactor.
//
//   2b. [DONE 95c5b6c2] IMPLEMENT IDB PATH-SYNC. idbStorage now implements
//      caps.journal / caps.content / caps.pathApply + per-mutation journaling via
//      the shared driver + a per-txn TreePort (conformance 5/5). The port
//      shape (from 2a) needed NO reshaping for IndexedDB — idb is the third proven
//      backend. Content was re-keyed from ino-addressed to HASH-addressed
//      (DB_VERSION 4->5): getBlob resolves ino->contentHash->bytes, putBlob hashes
//      then stores by hash, caps.content operates directly; LRU eviction re-keyed
//      to hashes (skips DIRTY inodes' content); unlink no longer GCs shared bytes.
//      New primitives: pathOf via a dirs 'by-ino' index, resolveIno, ensureDirPath,
//      enumerateSubtree, upsertInode; new journal + pathver object stores.
//
//   3. [IN PROGRESS · #454] THE MUTATION HOOK: THE FILESYSTEM ANNOUNCES, THE SYNC
//      MODULE RECORDS. Demoted once, for a reason that has since expired. The
//      demotion said the "composability" payoff needed a consumer that wanted to
//      ATTACH interception journaling, and native-fs (item 5) OBSERVES rather than
//      intercepts, so no such consumer existed. ID-ADDRESSED MOVES ARE THAT
//      CONSUMER. Our wire carries only put and delete AT A PATH, so `atomicMove`
//      explodes a directory rename into 2N journal rows (~160 ms for 4000
//      descendants) — Dropbox's Sync Engine Classic exactly, which their Nucleus
//      rewrite fixed by keying nodes by id so a move costs the same whatever the
//      subtree size. That is a SECOND interception strategy over the SAME backends:
//      same tree writes, different recording. Without the hook, adopting it means
//      editing `atomicMove` in three backends; with it, replacing one module.
//
//      Staged (each lands alone, conformance green throughout):
//        1. [DONE] The hook. `TreeEffect` + `MutationObserver` (below); every
//           backend's mutators announce one effect per tree change instead of
//           journaling, and `pathSyncObserver` records. `move` is ONE effect
//           whatever the subtree size — the observer, not the filesystem, decides
//           whether that means 2N rows or one. That is the line the swap needs, and
//           the only reason `move` is not modelled as unlink + link.
//        2. [DONE] Decouple the port from the wire: `upsertInode` takes
//           `InodeMeta`, and path versions + `appendJournalRow` live on a
//           sync-owned store.
//        3. `journal` / `pathApply` / `pathSnapshot` / `clearSyncState` leave
//           `StorageCapabilities`; `SyncReplica` is COMPOSED from (filesystem, sync
//           module) instead of read off `storage.caps`.
//        4. Move the files to `packages/sync` and let imports enforce the boundary.
//           Intention did not hold this line — a sync-shaped column reached
//           `fs_dirents` in #453 without anyone having to argue for it. A compiler
//           checks an import boundary.
//
//      The ONE hard constraint the demotion recorded stands, and is honoured: to
//      stay atomic the hook fires INSIDE the backend txn and hands the observer a
//      tx-scoped port (an after-commit `on('event')` cannot journal a delete — the
//      row is already gone). So a `Storage` wrapping a `Storage` can never work: a
//      wrapper cannot join the inner transaction, and the interface can never grow
//      a transaction primitive because `storage.fs.ts` could not implement one —
//      POSIX has no multi-file transaction. Composition here is INVERSION, not
//      decoration. Rejected alongside (kept for the record): a `treeOverOrderedKv`
//      engine implementing the tree over a generic store (flattens sqlite/idb to a
//      dumb KV, discarding their CTE / secondary-index strengths — not worth it).
//
//   4. [DONE(path-sync)] CONTENT GC. applyJournaled deliberately does NOT reclaim
//      orphaned blobs (a rename's delete would otherwise drop the bytes its own
//      put re-references, since orderForApply applies deletes before puts), so
//      owned backends leak orphaned content on delete-heavy sync. Fixed via
//      ContentStore.gcUnreferenced() — an out-of-band sweep reclaiming every stored
//      blob no inode's contentHash references. The same atomic operation first
//      compacts the journal to each path's latest row, preserving its seq so lagging
//      cursors still converge without retaining obsolete blob references. Triggering
//      is the app/host's call (reachable via storage.caps.content) — NOT auto-wired
//      into the sync loop (a full content scan every sync would be wasteful). And
//      caps.content.putByHash's hash-trust is now documented at the interface (the
//      sync engine supplies a pre-computed hash; re-hashing every pulled blob is
//      wasteful) — documentation over a dev-only verify, to stay minimal.
//
//   5. [TODO(path-sync)] NATIVE-FS SYNC (Path B: OBSERVE, don't intercept). the Mac app's
//      quay host runs the Volume over nativeStorage (a real Node fs). A real fs is an
//      OPEN system (Finder/git/editors mutate behind us) and cannot atomically
//      intercept-journal (fs write + sidecar journal are separate) — and any
//      intercept scheme needs a reconcile scan anyway, which IS scan+diff. So
//      native-fs is DETECTED by OBSERVATION, not interception: nativeChangeSource
//      walks `root`, diffs against a persisted NativeIndex (path -> {hash, mtime,
//      size, version}; the version AUTHORITY, replacing the DB path_version), and
//      uses FsWatcher (FSEvents/inotify) for incremental candidates. Scaffolded in
//      sync-replica.ts (nativeChangeSource + NativeIndex + FsWatcher, bodies throw).
//
//      PURELY ADDITIVE — no refactor of the DB path. New: the nativeChangeSource
//      body, a NativeIndex impl, an FsWatcher impl, a nativeSyncReplica (apply +
//      blob-serve over the fs's EXISTING lean mutators), and one branch in synced()
//      to pick native vs localSyncReplica. Untouched: every DB backend,
//      journaledChangeSource, localSyncReplica, caps.journal/pathApply/content, the
//      TreePort + applyJournaledOver driver.
//
//      THE SEAM REFRAMING (why this simplifies rather than diverges): native-fs
//      grows ZERO new Storage caps. It syncs over the lean CRUD it already
//      implements + a sidecar NativeIndex (SYNC-ENGINE state, not Storage state):
//      apply writes via putBlob/atomicCreate/deleteDirent (recording the applied
//      version in NativeIndex to suppress echo); blob-serve is hash->path via
//      NativeIndex + getBlob. This reveals caps.journal/pathApply/content as
//      localSyncReplica's DB-FLAVOURED ingredients, NOT the universal sync contract
//      — the universal contract is SyncReplica (= ChangeSource & ChangeApplier &
//      BlobStore), composed differently per backend. That is the whole unification;
//      below it, observe-vs-intercept divergence is INTRINSIC to the domain.
//
//      OPEN FOR v1: FsWatcher is per-OS (FSEvents on mac) — v1 may ship scan-only
//      (every delta re-scans+diffs; add the watcher later); content has no natural
//      hash-addressed store on a real fs (reverse-lookup via NativeIndex, no sidecar
//      blob cache). native-fs VALIDATES that SyncReplica is the right generic seam
//      (as idb validated TreePort); extract any real duplication AFTER it lands.
//      FIRST STEP (tracer bullet): implement nativeChangeSource.pathScan (full walk
//      -> puts) + an in-memory NativeIndex + a trivial FsWatcher, and prove a one-way
//      native -> mem sync through the conformance harness. No apply/persistence yet.

// ── Path helpers ──────────────────────────────────────────────────────────────

/** Split a canonical absolute path into `{ parentPath, name }`. */
export function splitPath(p: string): { parentPath: string; name: string } {
	const idx = p.lastIndexOf('/')
	return { parentPath: idx === 0 ? '/' : p.slice(0, idx), name: p.slice(idx + 1) }
}

/** Join a canonical directory path and a child name into a child path. */
export function joinPath(dirPath: string, name: string): string {
	return dirPath === '/' ? `/${name}` : `${dirPath}/${name}`
}

/** Path depth (segment count); '/' is 0, '/a' is 1, '/a/b' is 2. */
export function pathDepth(p: string): number {
	return p === '/' ? 0 : p.slice(1).split('/').length
}

// ── Version generation ──────────────────────────────────────────────────────

/**
 * The next outgoing version for a local mutation at a path: one past the higher
 * of the current version and any tombstone, so a resurrected path never sorts
 * below its own tombstone. Fast-forward only.
 */
export function nextVersion(currentVersion: number, tombstoneVersion: number): number {
	return Math.max(currentVersion, tombstoneVersion) + 1
}

// ── PathChange construction (the wire shape + contentHash rule) ───────────────

/**
 * Build a `put` `PathChange` from a resolved inode's current state. Returns
 * `null` for a fresh regular file that has no content yet (no `contentHash`):
 * its put is journaled later by the content write, so there is nothing to
 * journal now (the putBlob self-skip — proven benign, see ROADMAP item 3). Encapsulates the schema invariant that a
 * regular-file put carries a `contentHash` while dirs/symlinks must not.
 */
export function buildPutChange(
	path: string,
	meta: InodeMeta,
	xattrs: Record<string, Uint8Array>,
	version: number,
	source: string
): PathChange | null {
	if (meta.type === FileType.Regular && !meta.contentHash) return null
	const base = { kind: 'put' as const, path, version: encodeVersion(version), source }
	const sm = syncMetaFromInode(meta, xattrs)
	return meta.type === FileType.Regular
		? { ...base, contentHash: meta.contentHash, meta: sm }
		: { ...base, meta: sm }
}

/** Build a `delete` `PathChange` (carries only kind + path + version + source). */
export function buildDeleteChange(path: string, version: number, source: string): PathChange {
	return { kind: 'delete', path, version: encodeVersion(version), source }
}

// ── Ordering (child-before-parent deletes, parent-before-child puts) ──────────

/** Order items deepest-path-first (child before parent) — for deletes. */
export function sortChildFirst<T>(items: T[], pathOf: (t: T) => string): T[] {
	return [...items].sort((a, b) => pathDepth(pathOf(b)) - pathDepth(pathOf(a)))
}

/** Order items shallowest-path-first (parent before child) — for puts. */
export function sortParentFirst<T>(items: T[], pathOf: (t: T) => string): T[] {
	return [...items].sort((a, b) => pathDepth(pathOf(a)) - pathDepth(pathOf(b)))
}

// ── Deterministic conflict resolution (last-writer-wins) ──────────────────────

/**
 * Does `incoming` beat the current `local` state at the same path? The generic
 * LWW rule shared by every backend's apply: higher numeric `version` wins; on an
 * EXACT version tie, the higher source-independent `changeDigest` wins — so both
 * replicas pick the SAME winner and converge instead of swapping. `local === null`
 * (path never touched here) => incoming always wins. Digests are computed only on
 * a tie.
 */
export async function incomingWins(
	incoming: PathChange,
	local: PathChange | null
): Promise<boolean> {
	if (!local) return true
	const dv = compareVersion(incoming.version, local.version)
	if (dv !== 0) return dv > 0
	const [di, dl] = await Promise.all([changeDigest(incoming), changeDigest(local)])
	return di > dl
}

/**
 * Order a coalesced batch for a safe apply / journal: all `delete`s first,
 * child-before-parent (never orphan a live child under a deleted dir), then all
 * `put`s, parent-before-child (the dir exists before its entries).
 */
export function orderForApply(changes: PathChange[]): PathChange[] {
	const deletes = sortChildFirst(
		changes.filter((c) => c.kind === 'delete'),
		(c) => c.path
	)
	const puts = sortParentFirst(
		changes.filter((c) => c.kind === 'put'),
		(c) => c.path
	)
	return [...deletes, ...puts]
}

// ── Shared apply driver (the orchestration, over a tiny per-backend port) ──────
//
// `applyJournaled` / `localChange` / per-mutation journaling were IDENTICAL
// control flow in every owned backend, differing only in storage-primitive
// access (Map vs SQL vs IDB), tx wrapping, and emit timing. The orchestration
// now lives ONCE here, driven through `TreePort` + `PathSyncStore`; each backend
// supplies thin ports bound to its own store and, where relevant, transaction.
//
// What STAYS per-backend (cannot be shared): the IMPLEMENTATIONS — a Map walk vs
// a recursive CTE vs an IDB cursor — and atomicity / transaction boundaries. The
// port methods below are the minimal storage-independent seam the shared driver
// and the mutation observer need.

/**
 * The minimal per-backend storage seam the shared apply driver calls. Every
 * method is a small primitive over the backend's own store (bound to its
 * transaction where the backend is transactional). `emit` may defer until after
 * the backend's txn commits.
 *
 * Layer note: this is the RAW, un-journaled, txn-scoped storage layer — distinct
 * from `Storage`/`caps`, the JOURNALED, emitting, public layer above it (whose
 * mutators mint a new version + append to the journal as a side effect). The
 * apply driver deliberately uses this raw layer so it can journal the remote
 * change VERBATIM instead of minting a fresh local version.
 *
 * Scope note (@internal): a deliberately NARROW seam shared only by owned
 * journaling backends (mem, sqlite/DO, idb; future postgres). It is NOT a general
 * Storage seam and NOT part of the package's public API (kept off index.ts).
 * Non-journaling backends legitimately do not implement it — e.g. nativeStorage
 * (storage.fs.ts) has no journal/pathApply at all — it syncs by OBSERVATION
 * (ROADMAP item 5, scan+diff), which needs no port. ROADMAP item 3 (#454) is the
 * live refactor of WHO calls it: the mutation observer, not the backend. The seam
 * persists — do not widen it.
 */
export interface TreePort {
	/** Mint a fresh inode id (UUID, numeric, …) for a pulled path with no local inode. */
	mintIno(): Ino
	/** Resolve a canonical path to an ino by walking dirents; null if absent. */
	resolveIno(path: string): Promise<Ino | null>
	/**
	 * Resolve an ino to its canonical path by walking UP to root; null if the inode
	 * is unlinked (nothing names it, so there is no path to record).
	 */
	pathOf(ino: Ino): Promise<string | null>
	/**
	 * Every node in the subtree rooted at `ino`, as `{ ino, rel }` — the root's `rel`
	 * is `''` and a descendant's is its path relative to the root (`/a/b`). Only the
	 * backend can walk its own tree, but only the OBSERVER decides what a subtree
	 * costs to record, which is why this is on the port rather than in `atomicMove`.
	 */
	enumerateSubtree(ino: Ino): Promise<{ ino: Ino; rel: string }[]>
	/** Ensure every segment of a directory path exists (tree repair); return the deepest ino. */
	ensureDirPath(path: string): Promise<Ino>
	/** The entry currently linked at `(dirIno, name)`, or null. */
	getDirent(dirIno: Ino, name: string): Promise<DirentMin | null>
	/** Current metadata + user-xattr snapshot for an inode; null if it has no metadata. */
	readMetaXattrs(ino: Ino): Promise<{ meta: InodeMeta; xattrs: Record<string, Uint8Array> } | null>
	/** Install inode metadata + contentHash REFERENCE (never writes blob bytes). */
	upsertInode(
		ino: Ino,
		meta: InodeMeta,
		contentHash: string | undefined,
		xattrs: Record<string, Uint8Array>
	): Promise<void>
	/** Link `(dirIno, name) -> ino` (insert or rebind). */
	setDirent(dirIno: Ino, name: string, ino: Ino, type: FileType): Promise<void>
	/** Unlink `(dirIno, name)`. */
	deleteDirent(dirIno: Ino, name: string): Promise<void>
	/** Delete the inode's tree metadata + xattrs IF no dirent still references it. NEVER GCs blob content. */
	deleteInodeIfUnreferenced(ino: Ino): Promise<void>
	/** True if `ino` is a directory that still has at least one live child dirent. */
	dirHasLiveChildren(ino: Ino): Promise<boolean>
	/** Signal the change feed (volume cache + watch). Backends may defer past commit. */
	emit(change: StorageChange): void
}

/** Sync-owned persistence bound to the same transaction as its `TreePort`. */
export interface PathSyncStore {
	/** The path's `{ version, tombstone }` scalars ({0,0} when unknown). */
	readPathVersion(path: string): Promise<{ version: number; tombstone: number }>
	/** Persist the path's version + tombstone scalars. */
	setPathVersion(path: string, version: number, tombstone: number): Promise<void>
	/** Append one row to the path journal (the outbound sync source of truth). */
	appendJournalRow(change: PathChange, localSource?: string): Promise<void>
}

/**
 * The path's current local durable state, for the engine's LWW compare: a linked
 * path -> its put at the live version; else a tombstone -> its delete; else null.
 * `source` is excluded from the digest, so `actorId` is arbitrary.
 */
export async function localChangeOver(
	port: TreePort,
	store: PathSyncStore,
	path: string,
	actorId: string
): Promise<PathChange | null> {
	const ino = await port.resolveIno(path)
	if (ino !== null) {
		const mx = await port.readMetaXattrs(ino)
		if (mx) {
			const cur = await store.readPathVersion(path)
			return buildPutChange(path, mx.meta, mx.xattrs, cur.version, actorId)
		}
	}
	const cur = await store.readPathVersion(path)
	return cur.tombstone > 0 ? buildDeleteChange(path, cur.tombstone, actorId) : null
}

/**
 * Journal a local `put` for a linked path from the inode's current state. An
 * explicit `options.version` pins the outgoing version exactly (up OR down);
 * otherwise the next version is generated. Self-skips (journals nothing, consumes
 * no version) a fresh regular file with no content yet — its put is journaled by
 * the following content write once hashed (see `buildPutChange`; benign per
 * ROADMAP item 3's empty-file finding).
 */
export async function journalPutOver(
	port: TreePort,
	store: PathSyncStore,
	path: string,
	ino: Ino,
	actorId: string,
	options?: MutationOptions
): Promise<void> {
	const mx = await port.readMetaXattrs(ino)
	if (!mx) return
	const cur = await store.readPathVersion(path)
	const version = options?.version ?? nextVersion(cur.version, cur.tombstone)
	const change = buildPutChange(path, mx.meta, mx.xattrs, version, options?.source ?? actorId)
	if (!change) return
	await store.setPathVersion(path, version, cur.tombstone)
	await store.appendJournalRow(change)
}

/** Journal a local `delete` for a path and fast-forward its tombstone high-water. */
export async function journalDeleteOver(
	store: PathSyncStore,
	path: string,
	actorId: string,
	options?: MutationOptions
): Promise<void> {
	const cur = await store.readPathVersion(path)
	const version = nextVersion(cur.version, cur.tombstone)
	await store.setPathVersion(path, version, Math.max(cur.tombstone, version))
	await store.appendJournalRow(buildDeleteChange(path, version, options?.source ?? actorId))
}

// ── The mutation hook (ROADMAP item 3 / #454) ─────────────────────────────────

/**
 * What changed in the tree, in the FILESYSTEM's own vocabulary — no paths, no
 * versions, no wire. One effect per tree change, announced in the order applied.
 *
 * `move` is ONE effect whatever the subtree size: the filesystem does not
 * enumerate descendants, and the observer decides whether a directory rename
 * means 2N rows or one. That is the only reason `move` is not modelled as
 * `unlink` + `link`, and it is what makes an id-addressed recorder a module swap
 * rather than a third edit to `atomicMove`.
 */
export type TreeEffect =
	| { kind: 'link'; dirIno: Ino; name: string; ino: Ino; type: FileType }
	| { kind: 'unlink'; dirIno: Ino; name: string; ino: Ino }
	| {
			kind: 'move'
			fromDirIno: Ino
			fromName: string
			toDirIno: Ino
			toName: string
			ino: Ino
			/** The inode the move overwrote at the destination, or null. */
			displaced: Ino | null
	  }
	| { kind: 'meta'; ino: Ino }
	| { kind: 'content'; ino: Ino; contentHash: string }

/**
 * Whoever records what the filesystem announced. Called INSIDE the mutation's own
 * transaction, AFTER the tree write, with a tx-scoped port for its reads and for
 * writing its own state — never after commit, where an unlink's row is already
 * gone and the recording could no longer roll back with the mutation.
 *
 * The filesystem never reads back anything an observer wrote.
 */
export interface MutationObserver {
	record(port: TreePort, effect: TreeEffect, options?: MutationOptions): Promise<void>
}

/**
 * The path-addressed observer: records every effect as journal rows at canonical
 * paths, which is what today's wire (put/delete AT A PATH) can carry. A directory
 * move therefore costs 2N rows — an ordered subtree delete (child-before-parent,
 * so no live child is ever orphaned under a deleted dir) then put
 * (parent-before-child, so the dir exists before its entries). That cost lives
 * HERE, in one place, precisely so an id-addressed recorder can replace it
 * without touching a backend.
 *
 * An effect on an inode nothing names (`pathOf` -> null) records nothing: there
 * is no path to journal it at. That covers `createNode`'s bare `setMeta` before
 * the dirent exists, and any write through a detached subtree.
 */
export function pathSyncObserver(store: PathSyncStore, actorId: string): MutationObserver {
	return {
		async record(port, effect, options) {
			switch (effect.kind) {
				case 'link': {
					const dirPath = await port.pathOf(effect.dirIno)
					if (dirPath === null) return
					await journalPutOver(
						port,
						store,
						joinPath(dirPath, effect.name),
						effect.ino,
						actorId,
						options
					)
					return
				}
				case 'unlink': {
					const dirPath = await port.pathOf(effect.dirIno)
					if (dirPath === null) return
					await journalDeleteOver(store, joinPath(dirPath, effect.name), actorId, options)
					return
				}
				case 'move': {
					const fromDirPath = await port.pathOf(effect.fromDirIno)
					const toDirPath = await port.pathOf(effect.toDirIno)
					if (fromDirPath === null || toDirPath === null) return
					const oldBase = joinPath(fromDirPath, effect.fromName)
					const newBase = joinPath(toDirPath, effect.toName)
					// Enumerated AFTER the rebind, which is safe and is the point: a move
					// rebinds the TOP entry only, so every descendant keeps its
					// parent-ino-keyed dirent and the subtree's shape is unchanged.
					const subtree = await port.enumerateSubtree(effect.ino)
					for (const p of sortChildFirst(
						subtree.map((n) => oldBase + n.rel),
						(x) => x
					))
						await journalDeleteOver(store, p, actorId, options)
					// A moved regular file keeps its contentHash, so this put references the
					// already-present bytes — only the name moved.
					for (const n of sortParentFirst(subtree, (x) => newBase + x.rel))
						await journalPutOver(port, store, newBase + n.rel, n.ino, actorId, options)
					return
				}
				// Both are a put of the inode's current state at its path — the journal row
				// is built by reading the inode back, so `content`'s hash needs no special
				// handling here. They stay separate effects because the FILESYSTEM
				// distinguishes them, and an observer is free to as well.
				case 'meta':
				case 'content': {
					const path = await port.pathOf(effect.ino)
					if (path === null) return
					await journalPutOver(port, store, path, effect.ino, actorId, options)
				}
			}
		}
	}
}

/**
 * Remote-authored apply: for each change (already coalesced + ordered by the
 * engine), install tree metadata + contentHash REFERENCE (blob bytes are
 * materialised out-of-band), journal the change VERBATIM (its version + origin
 * source) tagged with `localSource`, and fast-forward path_version (never lower
 * it). NEVER writes blob bytes; NEVER GCs blob content on delete (a later put in
 * the same batch may re-reference the same bytes — see ROADMAP item 4). Emits are
 * routed through `port.emit`, so a transactional backend can defer them to after
 * commit.
 */
export async function applyJournaledOver(
	port: TreePort,
	store: PathSyncStore,
	changes: PathChange[],
	opts: { localSource?: string }
): Promise<void> {
	for (const change of changes) {
		const p = change.path
		const changeVersion = Number(change.version)
		if (change.kind === 'put') {
			const { parentPath, name } = splitPath(p)
			const parentIno = await port.ensureDirPath(parentPath)
			const bound = await port.getDirent(parentIno, name)
			const ino = bound?.ino ?? port.mintIno()
			const type = change.meta.type
			const { meta, xattrs } = inodeMetaFromSync(change.meta)
			await port.upsertInode(ino, { ...meta, ctimeNs: 0n }, change.contentHash, xattrs)
			await port.setDirent(parentIno, name, ino, type)
			port.emit({ ino, kind: 'meta', source: opts.localSource })
			// `dirent` means the parent's entry SET changed, so it is emitted only when
			// this put (re)binds the name — nothing was linked here, or what was linked
			// is now a different KIND of thing. A put over a path we already hold is a
			// content/meta edit and must emit exactly what the local `writeFile` emits;
			// otherwise every pulled edit reads as a STRUCTURAL change: a recursive
			// watcher wakes, an app folds that wake into persisted state, the kernel
			// writes the state back, the write pushes, and the peer applies it as another
			// "structural" change — a two-replica loop with no user in it.
			if (bound === null || bound.type !== type)
				port.emit({
					ino,
					kind: 'dirent',
					dirIno: parentIno,
					name,
					path: p,
					source: opts.localSource
				})
			if (type === FileType.Regular) port.emit({ ino, kind: 'content', source: opts.localSource })
		} else {
			const ino = await port.resolveIno(p)
			// Tree-integrity invariant: a delete NEVER removes a directory that still
			// has live children. A descendant whose own higher-version put beat this
			// subtree delete must stay reachable, so the ancestor delete loses here —
			// the peer that instead applies the surviving child's put resurrects the
			// ancestor via ensureDirPath (a winning descendant edit vs a deleted
			// ancestor). Skip entirely: no unlink, no tombstone, no journal row.
			if (ino !== null) {
				const mx = await port.readMetaXattrs(ino)
				if (mx?.meta.type === FileType.Directory && (await port.dirHasLiveChildren(ino))) continue
			}
			const { parentPath, name } = splitPath(p)
			const parentIno = await port.resolveIno(parentPath)
			if (parentIno !== null) await port.deleteDirent(parentIno, name)
			if (ino !== null) await port.deleteInodeIfUnreferenced(ino)
			if (ino !== null && parentIno !== null)
				port.emit({
					ino,
					kind: 'dirent',
					dirIno: parentIno,
					name,
					path: p,
					source: opts.localSource
				})
			if (ino !== null) port.emit({ ino, kind: 'meta', source: opts.localSource })
		}
		const cur = await store.readPathVersion(p)
		const tombstone =
			change.kind === 'delete' ? Math.max(cur.tombstone, changeVersion) : cur.tombstone
		await store.setPathVersion(p, Math.max(cur.version, changeVersion), tombstone)
		await store.appendJournalRow(change, opts.localSource)
	}
}
