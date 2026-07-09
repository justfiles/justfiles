/**
 * Pure path-sync rules shared by every owned backend (mem, SQLite/DO, IDB).
 *
 * These are the nuanced, bug-prone decisions — version generation, tombstone
 * fast-forward, the regular-file `contentHash` rule, wire construction, and the
 * child-before-parent / parent-before-child ordering — extracted as PURE
 * functions so they are written once, tested directly, and SHIP in every
 * backend (rather than living only in the `memStorage` test double).
 *
 * Deliberately NOT an abstraction (yet): no port, no transaction interface. Each
 * backend keeps its own storage access + atomicity and CALLS these helpers. The
 * `pathOf(ino)` walk and subtree enumeration stay per-backend (they touch the
 * backend's own index/tables), because backends legitimately differ there (a
 * Map walk vs a set-based SQL query). See PATH-SYNC ROADMAP item 2 below for the
 * planned apply-driver port, to be introduced once IDB validates the shape.
 */

import type { InodeMeta } from './storage'
import type { PathChange } from './sync-wire'
import { changeDigest, compareVersion, encodeVersion, syncMetaFromInode } from './sync-wire'
import { FileType } from './types'

// ── PATH-SYNC ROADMAP (ordered; post-SQLite epic) ─────────────────────────────
//
// SQLite is the first fully-proven owned backend (conformance 5/5). The work
// below is QUEUED in dependency order — do it top-to-bottom, each a separate
// commit / small epic. Recorded HERE (the shared center every backend imports)
// so the plan survives session breaks. Grep `TODO(path-sync)`.
//
//   1. [TODO(path-sync)] REMOVE THE LEGACY FsOp DELTA PROTOCOL. It has no
//      production consumer — `synced()` (path-sync) is the live driver in the
//      frieren + worker apps, and mem never even implemented it. Delete:
//      caps.deltaUpdates + caps.applyBatch (storage.ts + sqlite/idb impls),
//      FsOp / UpdateQueryOptions / encodeOp, the fs_updates table + appendOps +
//      pruneUpdates (and their per-mutation call sites), the /delta + /ops routes
//      in fs.ts, and fs.client's deltaUpdates/applyBatch. KEEP caps.fullScan
//      (volume.scan tree-walk needs entries/next) but drop its sync-only
//      `syncCursor` field. Do this FIRST — it de-clutters every mutator before
//      the extraction below.
//
//   2. [TODO(path-sync)] EXTRACT THE SHARED APPLY DRIVER. Do this as the FIRST
//      step of the IDB epic, using idb as the third impl that validates the port
//      shape — NOT before (a port shaped by only mem + sqlite risks baking in
//      SQLite quirks). Today applyJournaled / localChange / journalPut /
//      journalDelete are copy-pasted between storage.mem.ts and storage.sqlite.ts
//      as IDENTICAL control flow over storage-specific primitives. Introduce a
//      tiny per-backend port and move the orchestration into this module:
//
//        interface PathStore {          // per backend; stays minimal
//          resolveIno(p): Ino|null;  ensureDirPath(p): Ino;  mintIno(): Ino
//          readMetaXattrs(ino): { meta, xattrs } | null
//          upsertInodeFromSync(ino, change);  setDirent(dir, name, ino, type)
//          deleteInode(ino) /* NO blob GC */;  deleteDirent(dir, name)
//          readPathVersion(p): { version, tombstone };  setPathVersion(p, v, t)
//          appendJournalRow(change, localSource?);  emit(change)
//        }
//        applyJournaledOver(port, changes, opts)
//        localChangeOver(port, path, actorId)
//        journalMutationOver(port, kind, path, ino?, actorId, options)
//
//      Deletes ~120-150 duplicated lines PER backend and makes idb's apply nearly
//      free. pathOf / resolveIno / ensureDirPath / enumerateSubtree stay
//      per-backend (Map-walk vs recursive CTE) — they cannot be shared. While
//      here, set ctime = nowNs() at apply (not 0 — ctime is a local attr, never
//      compared for convergence).
//
//   3. [TODO(path-sync)] ADR: UNIFY THE TWO CHANGE MECHANISMS + LOGICAL-OPERATION
//      JOURNALING. After the legacy protocol is gone (item 1), two remain: the
//      durable journal (sync source of truth) and the ephemeral emit()/subscribe
//      feed (volume cache + watch). Collapse to "one change, two consumption
//      modes": every committed mutation appends to the journal AND broadcasts
//      in-process; subscribe = tail the journal. Blocker: the journal is
//      PATH-keyed, volume caches are INO/DIRINO-keyed — the unified record must
//      carry both (or volume invalidates by path). Fold in logical-operation
//      journaling: journal a path's SETTLED state at the VFS-operation boundary
//      rather than per-store-op. This removes the putBlob self-skip hack (a
//      regular-file create currently journals on the FOLLOWING putBlob once
//      hashed — see buildPutChange returning null) WHILE keeping content a
//      separate hash-addressed resource, so meta-first / blob-on-demand stays
//      cheap (a rename ships ZERO bytes because the moved paths reuse existing
//      contentHashes). Do AFTER idb (two owned backends validate the record
//      shape). Add a conformance case first: "create an EMPTY regular file (no
//      putBlob), then sync" — the self-skip predicts it is currently never
//      journaled.
//
//   4. [TODO(path-sync)] CONTENT GC. applyJournaled deliberately does NOT reclaim
//      orphaned blobs (a rename's delete would otherwise drop the bytes its own
//      put re-references, since orderForApply applies deletes before puts). All
//      owned backends now leak orphaned content on delete-heavy sync. Add an
//      explicit out-of-band sweep (sqlite: DELETE FROM fs_contents WHERE
//      content_hash NOT IN (SELECT content_hash FROM fs_inodes WHERE content_hash
//      IS NOT NULL)), never in the apply path. Also: caps.content.putByHash TRUSTS
//      the caller's hash — document the trust boundary / add a dev-only verify.

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
 * journal now (the putBlob self-skip — ROADMAP item 3 replaces this with
 * logical-operation journaling). Encapsulates the schema invariant that a
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
