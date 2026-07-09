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
 * `journalDeleteOver`) runs over a tiny per-backend `PathStorePort`. Each backend
 * still owns its storage access, atomicity, `pathOf(ino)` walk, and subtree
 * enumeration (a Map walk vs a set-based SQL query vs an IDB cursor) — the port
 * is only the storage-independent seam the shared driver needs. See PATH-SYNC
 * ROADMAP item 2 below.
 */

import type { InodeMeta, MutationOptions, StorageChange } from './storage'
import type { PathChange } from './sync-wire'
import { changeDigest, compareVersion, encodeVersion, syncMetaFromInode } from './sync-wire'
import type { Ino } from './types'
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
//      the per-backend `PathStorePort` (below). mem + sqlite were retrofitted and
//      stay green (sqlite conformance 5/5). pathOf / resolveIno-walk /
//      ensureDirPath / enumerateSubtree stay per-backend (Map-walk vs recursive
//      CTE) — they cannot be shared. NOTE: the port was shaped from mem + sqlite
//      only; idb (2b) is the third impl that VALIDATES it — reshape the port there
//      if idb needs it (mem + sqlite conformance guard against regressions).
//      STILL TODO (micro): set ctime = nowNs() at apply (currently 0n in each
//      backend's port.upsertInodeFromSync) — ctime is a local attr, never compared
//      for convergence; deferred to keep 2a a pure refactor.
//
//   2b. [DONE 95c5b6c2] IMPLEMENT IDB PATH-SYNC. idbStorage now implements
//      caps.journal / caps.content / caps.pathApply + per-mutation journaling via
//      the shared driver + a per-txn PathStorePort (conformance 5/5). The port
//      shape (from 2a) needed NO reshaping for IndexedDB — idb is the third proven
//      backend. Content was re-keyed from ino-addressed to HASH-addressed
//      (DB_VERSION 4->5): getBlob resolves ino->contentHash->bytes, putBlob hashes
//      then stores by hash, caps.content operates directly; LRU eviction re-keyed
//      to hashes (skips DIRTY inodes' content); unlink no longer GCs shared bytes.
//      New primitives: pathOf via a dirs 'by-ino' index, resolveIno, ensureDirPath,
//      enumerateSubtree, upsertInodeFromSync; new journal + pathver object stores.
//
//   3. [BLOCKED ON item 5 · path-sync] ADR: JOURNALING AS A COMPOSABLE, IN-TXN
//      CHANGE STREAM. (Do NOT start before native-fs exists — see TIMING.)
//      Today journaling is BAKED INTO each backend: every mutator calls
//      journalPutOver/journalDeleteOver, owns journal + pathver stores, and imports
//      the driver. Target (composition, not coupling): backends become journaling-
//      AGNOSTIC — at each mutation they merely announce "path P now has this
//      meta/hash" / "path P deleted", and an ATTACHED journaling extension turns
//      that into durable rows. This also unifies the two change mechanisms that
//      coexist after item 1 — the durable journal (sync source of truth) and the
//      ephemeral emit()/subscribe feed (volume cache + watch) — into "one change,
//      two subscribers": the journal builds PathChange rows; the volume invalidates
//      its cache / fires watch. So the unified record must carry BOTH the path (for
//      the journal) AND ino/dirIno (for the volume).
//
//      THE ONE HARD CONSTRAINT (established in design discussion): to KEEP
//      atomicity, the mutation event must fire INSIDE the backend's transaction
//      and hand the handler a tx-scoped toolset (pathOf, readMeta, readPathVersion,
//      setPathVersion, appendJournalRow). A vanilla AFTER-COMMIT `on('event')` (=
//      today's emit/subscribe) CANNOT journal: it is not atomic, and on a delete the
//      inode/dirent is already gone so the handler cannot reconstruct the change.
//      That tx-scoped toolset IS a PathStorePort delivered by callback instead of
//      via a `transact(fn)` wrapper — the hook RELOCATES who calls the port, it does
//      not remove it. Upside over a withJournaling wrapper: the backend does its
//      OWN byte/tree write and only fires the hook, so the hook's port is SMALLER
//      (no raw write ops — just the journal-building reads/writes).
//
//      OUTBOUND HALF ONLY. applyJournaled (writing REMOTE tree state without
//      re-journaling) is not an observation problem — it still needs tree-write
//      access, so keep caps.pathApply per-backend (or suppress hooks during apply).
//      Hooks make local-mutation journaling clean; inbound apply stays as-is.
//
//      ATOMICITY IS A PER-BACKEND CAPABILITY, NOT A FORK: sqlite/idb fire the hook
//      in their real txn (atomic). native-fs — the backend that most wants "attach
//      journaling by composition" — CANNOT (its sidecar journal is not in the fs
//      txn), so it degrades to an after-commit hook + a reconcile scan on open (walk
//      the tree via caps.fullScan, diff against last-journaled path_version, emit
//      missing rows). Path-sync is LWW-convergent + idempotent, so a re-derived-late
//      entry is harmless. Design the event contract to serve BOTH the atomic and
//      best-effort consumers — validate WITH native-fs in hand, not frozen against
//      DB backends only. (Handlers must be txn-safe: no foreign await mid-idb-txn.)
//
//      FOLD IN LOGICAL-OPERATION JOURNALING: journal a path's SETTLED state at the
//      VFS-operation boundary, not per-store-op. This removes the putBlob self-skip
//      hack (a regular-file create currently journals on the FOLLOWING putBlob once
//      hashed — see buildPutChange returning null) WHILE keeping content a separate
//      hash-addressed resource (a rename ships ZERO bytes — moved paths reuse
//      existing contentHashes). FIRST STEP — DONE: the "converges an empty regular
//      file" conformance case (green on mem/sqlite/idb) proves the self-skip is
//      BENIGN via the public VFS — writeFile/appendFile ALWAYS end in a putBlob
//      (empty content hashes to sha256(''), which journals the put), and the only
//      no-putBlob creators are the sync-apply path (journals verbatim). So there is
//      no reachable "regular file that never journals": logical-op journaling here
//      is a CLEANLINESS refactor (collapse the two-step create-then-content
//      journaling), NOT a correctness fix.
//
//      TIMING: journaling already works atomically (baked-in), so this is a
//      separation-of-concerns refactor, not a new capability — NO urgency. HARD
//      DEPENDENCY: do it TOGETHER with item 5 (native-fs), the only consumer that
//      exercises the after-commit-hook + reconcile degradation path (mem/sqlite/idb
//      are all transact-atomic). Starting now would freeze the event contract
//      against one strategy and force a redo — the exact over-fit we avoided when
//      idb validated PathStorePort. Rejected alongside: a `treeOverOrderedKv` engine
//      that implements the tree over a generic store (flattens sqlite/idb to a dumb
//      KV, discarding their CTE / secondary-index strengths for ~150 mechanical
//      lines — not worth it).
//
//   4. [DONE(path-sync)] CONTENT GC. applyJournaled deliberately does NOT reclaim
//      orphaned blobs (a rename's delete would otherwise drop the bytes its own
//      put re-references, since orderForApply applies deletes before puts), so
//      owned backends leak orphaned content on delete-heavy sync. Fixed via
//      ContentStore.gcUnreferenced() — an out-of-band sweep reclaiming every stored
//      blob no inode's contentHash references (sqlite: one `NOT IN` delete reusing
//      maybeDeleteOrphanedContent for FTS + R2-key cleanup; mem/idb: build the live
//      set from inodes, drop the rest), NEVER in the apply path. Triggering is the
//      app/host's call (reachable via storage.caps.content) — NOT auto-wired into
//      the sync loop (a full content scan every sync would be wasteful). And
//      caps.content.putByHash's hash-trust is now documented at the interface (the
//      sync engine supplies a pre-computed hash; re-hashing every pulled blob is
//      wasteful) — documentation over a dev-only verify, to stay minimal.
//
//   5. [TODO(path-sync)] NATIVE-FS SYNC — THE PREREQUISITE FOR ITEM 3. spud-mac's
//      quay host runs the Volume over nativeStorage (a real Node fs). All access
//      routes through our Storage API (DESIGN.md rejects "each .app is the store"),
//      so journaling-by-interception works — BUT the journal is a sidecar (external
//      sqlite / a .git-style folder) that CANNOT be made atomic with the fs write.
//      So native-fs is the SECOND journaling strategy: best-effort in-line journal
//      + a reconcile-on-open scan (walk via caps.fullScan, diff last-journaled
//      path_version, emit missing rows) — already scaffolded as nativeChangeSource
//      + NativeIndex + FsWatcher in sync-replica.ts (bodies throw 'not implemented').
//      This is the ONLY consumer that exercises item 3's after-commit-hook +
//      reconcile degradation path (mem/sqlite/idb are all transact-atomic), so
//      item 3's event contract must be designed AND validated with it in hand. Out
//      of scope until spud-mac sync is picked up; when it is, do item 5 + item 3
//      together, co-validated.

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

// ── Shared apply driver (the orchestration, over a tiny per-backend port) ──────
//
// `applyJournaled` / `localChange` / per-mutation journaling were IDENTICAL
// control flow in every owned backend, differing only in storage-primitive
// access (Map vs SQL vs IDB), tx wrapping, and emit timing. The orchestration
// now lives ONCE here, driven through `PathStorePort`; each backend supplies a
// thin port bound to its own store (and, where relevant, its own transaction).
//
// What STAYS per-backend (cannot be shared): pathOf(ino), subtree enumeration,
// and atomicity/transaction boundaries — a Map walk vs a recursive CTE vs an IDB
// cursor are legitimately different. The port methods below are the minimal
// storage-independent seam the shared driver needs.

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
 * (storage.fs.ts) has no journal/pathApply at all. ROADMAP item 3 may relocate
 * WHO calls this port (an in-txn mutation hook the backend fires, rather than the
 * driver pulling) — the seam persists either way; do not widen it.
 */
export interface PathStorePort {
	/** Mint a fresh inode id (UUID, numeric, …) for a pulled path with no local inode. */
	mintIno(): Ino
	/** Resolve a canonical path to an ino by walking dirents; null if absent. */
	resolveIno(path: string): Promise<Ino | null>
	/** Ensure every segment of a directory path exists (tree repair); return the deepest ino. */
	ensureDirPath(path: string): Promise<Ino>
	/** The ino currently linked at `(dirIno, name)`, or null. */
	getDirentIno(dirIno: Ino, name: string): Promise<Ino | null>
	/** Current metadata + user-xattr snapshot for an inode; null if it has no metadata. */
	readMetaXattrs(ino: Ino): Promise<{ meta: InodeMeta; xattrs: Record<string, Uint8Array> } | null>
	/** Install a remote put's tree metadata + contentHash REFERENCE (never writes blob bytes). */
	upsertInodeFromSync(ino: Ino, change: PathChange): Promise<void>
	/** Link `(dirIno, name) -> ino` (insert or rebind). */
	setDirent(dirIno: Ino, name: string, ino: Ino, type: FileType): Promise<void>
	/** Unlink `(dirIno, name)`. */
	deleteDirent(dirIno: Ino, name: string): Promise<void>
	/** Delete the inode's tree metadata + xattrs IF no dirent still references it. NEVER GCs blob content. */
	deleteInodeIfUnreferenced(ino: Ino): Promise<void>
	/** True if `ino` is a directory that still has at least one live child dirent. */
	dirHasLiveChildren(ino: Ino): Promise<boolean>
	/** The path's `{ version, tombstone }` scalars ({0,0} when unknown). */
	readPathVersion(path: string): Promise<{ version: number; tombstone: number }>
	/** Persist the path's version + tombstone scalars. */
	setPathVersion(path: string, version: number, tombstone: number): Promise<void>
	/** Append one row to the path journal (the outbound sync source of truth). */
	appendJournalRow(change: PathChange, localSource?: string): Promise<void>
	/** Signal the change feed (volume cache + watch). Backends may defer past commit. */
	emit(change: StorageChange): void
}

/**
 * The path's current local durable state, for the engine's LWW compare: a linked
 * path -> its put at the live version; else a tombstone -> its delete; else null.
 * `source` is excluded from the digest, so `actorId` is arbitrary.
 */
export async function localChangeOver(
	port: PathStorePort,
	path: string,
	actorId: string
): Promise<PathChange | null> {
	const ino = await port.resolveIno(path)
	if (ino !== null) {
		const mx = await port.readMetaXattrs(ino)
		if (mx) {
			const cur = await port.readPathVersion(path)
			return buildPutChange(path, mx.meta, mx.xattrs, cur.version, actorId)
		}
	}
	const cur = await port.readPathVersion(path)
	return cur.tombstone > 0 ? buildDeleteChange(path, cur.tombstone, actorId) : null
}

/**
 * Journal a local `put` for a linked path from the inode's current state. An
 * explicit `options.version` pins the outgoing version exactly (up OR down);
 * otherwise the next version is generated. Self-skips (journals nothing, consumes
 * no version) a fresh regular file with no content yet — its put is journaled by
 * the following content write once hashed (see `buildPutChange` / ROADMAP item 3).
 */
export async function journalPutOver(
	port: PathStorePort,
	path: string,
	ino: Ino,
	actorId: string,
	options?: MutationOptions
): Promise<void> {
	const mx = await port.readMetaXattrs(ino)
	if (!mx) return
	const cur = await port.readPathVersion(path)
	const version = options?.version ?? nextVersion(cur.version, cur.tombstone)
	const change = buildPutChange(path, mx.meta, mx.xattrs, version, options?.source ?? actorId)
	if (!change) return
	await port.setPathVersion(path, version, cur.tombstone)
	await port.appendJournalRow(change)
}

/** Journal a local `delete` for a path and fast-forward its tombstone high-water. */
export async function journalDeleteOver(
	port: PathStorePort,
	path: string,
	actorId: string,
	options?: MutationOptions
): Promise<void> {
	const cur = await port.readPathVersion(path)
	const version = nextVersion(cur.version, cur.tombstone)
	await port.setPathVersion(path, version, Math.max(cur.tombstone, version))
	await port.appendJournalRow(buildDeleteChange(path, version, options?.source ?? actorId))
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
	port: PathStorePort,
	changes: PathChange[],
	opts: { localSource?: string }
): Promise<void> {
	for (const change of changes) {
		const p = change.path
		const changeVersion = Number(change.version)
		if (change.kind === 'put') {
			const { parentPath, name } = splitPath(p)
			const parentIno = await port.ensureDirPath(parentPath)
			const ino = (await port.getDirentIno(parentIno, name)) ?? port.mintIno()
			const type = change.meta.type
			await port.upsertInodeFromSync(ino, change)
			await port.setDirent(parentIno, name, ino, type)
			port.emit({ ino, kind: 'meta', source: opts.localSource })
			port.emit({ ino, kind: 'dirent', dirIno: parentIno, name, source: opts.localSource })
			if (type === FileType.Regular) port.emit({ ino, kind: 'content', source: opts.localSource })
		} else {
			const ino = await port.resolveIno(p)
			// Tree-integrity invariant: a delete NEVER removes a directory that still
			// has live children. A descendant whose own higher-version put beat this
			// subtree delete must stay reachable, so the ancestor delete loses here —
			// the peer that instead applies the surviving child's put resurrects the
			// ancestor via ensureDirPath (RED 14: a winning descendant edit vs a
			// deleted ancestor). Skip entirely: no unlink, no tombstone, no journal row.
			if (ino !== null) {
				const mx = await port.readMetaXattrs(ino)
				if (mx?.meta.type === FileType.Directory && (await port.dirHasLiveChildren(ino))) continue
			}
			const { parentPath, name } = splitPath(p)
			const parentIno = await port.resolveIno(parentPath)
			if (parentIno !== null) await port.deleteDirent(parentIno, name)
			if (ino !== null) await port.deleteInodeIfUnreferenced(ino)
			if (ino !== null && parentIno !== null)
				port.emit({ ino, kind: 'dirent', dirIno: parentIno, name, source: opts.localSource })
			if (ino !== null) port.emit({ ino, kind: 'meta', source: opts.localSource })
		}
		const cur = await port.readPathVersion(p)
		const tombstone =
			change.kind === 'delete' ? Math.max(cur.tombstone, changeVersion) : cur.tombstone
		await port.setPathVersion(p, Math.max(cur.version, changeVersion), tombstone)
		await port.appendJournalRow(change, opts.localSource)
	}
}
