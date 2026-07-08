# Path-based sync for `@justfiles/fs`

Status: proposal / design. No code yet. This doc is the artifact to pressure-test
before implementation.

> Revised per review feedback in **issue #141**. Round 1: correct path-journaling
> with tombstones (not final-state resolution); explicit blob-push protocol;
> path-keyed sync state; lazy = desired-hash vs blob-presence; scan/cursor
> semantics; a lean `SyncReplica` adapter instead of bloating `Storage`;
> `sync-v2` migration; spec-nits; tightened tests. Round 2 refinements folded in.
> **Round 3: the sync engine is uniform and app-agnostic** — one conflict policy
> for all paths, zero knowledge of `/applications/**`; app update / no-downgrade
> is a layer on top that watches file changes (`docs/app-materialization.md`).
> **Round 4 (issue #142):** split the snapshot page-token from the sync
> high-water cursor; resolve the conflict-copy contradiction by deferring
> conflict copies uniformly (v1 = LWW+log everywhere, bootstrap included — keep
> local + version-bump, no copy); specify the adoption version bump; pin down
> where the scalar path `version` lives and how it increments; spell out
> directory-move journaling + the child→parent index it needs; define `/.state/**`
> path exclusion as the local-only replacement; tighten the wire schema
> (`ctimeNs`, xattr snapshot semantics, `contentHash` format, normalized path
> schema); make push `source` server-stamped from the authenticated request
> context (robustness within one user's device fleet, not a security boundary).

## TL;DR

`packages/fs/synced.ts` currently reconciles two replicas by **inode id (`ino`)**.
An `ino` is a *local* identity — it means nothing on another machine. Using it as
the *cross-replica* identity causes two failures:

1. **Forking.** When two replicas independently create the same path (e.g. the
   client seeds `/applications/app.code` and the server also materialises it),
   they mint different inos for the same path. Neither side's ops address the
   other's inos, so the change lands in an unreachable subtree and never
   converges — while sync reports "synced".
2. **It cannot ever sync heterogeneous backends.** The native backend
   (`storage.fs.ts`) uses **real OS inode numbers**; IDB/DO use UUIDs. Their ino
   spaces are disjoint, so ino-based sync between spud-mac (native) and the
   frieren backend is structurally impossible — and that's on the roadmap.

Fix: make the **sync boundary path-addressed** (Syncthing's model). The tree is
identified by **path**, blobs by **content hash** (already true in R2). `ino`
stays a purely local, path-independent identity (correct real-fs modelling: hard
links, fast `mv`, native backend passthrough).

This doc keeps the change focused: a new **`SyncReplica`** adapter owns the path
wire protocol; `Storage` stays the lean local-fs primitive.

---

## Context: what went wrong (the incident)

A signed-in frieren profile showed `app.code` stuck at `0.1.0` with no `.apphash`,
while the server (DO) had `0.1.1` with `.apphash`. Forensics on the DO
(`.wrangler/state/v3/do/...sqlite`):

- Server-side reconcile is **correct**: `/applications/app.code` = `0.1.1`,
  complete, `.apphash` matches the catalog whole-app hash. Installed once.
- The browser replica had its **own** `/applications/app.code` (older, from a
  local-only seed by the pre-`.apphash` reconcile). Sync reported "synced", no
  console error, yet the browser never adopted the server's copy.
- The DO logged `fs/ops: skipped dangling set-dirent <ino>/<name> → missing
  parent <ino>` — the browser was pushing dirents whose **parent ino the server
  never had**.

Root cause: the two replicas minted **different inos for the same paths**. Because
sync is ino-keyed, the server's `set-dirent(server_applications_ino, "app.code",
…)` writes under an ino the browser's root doesn't reference — an unreachable
"phantom" subtree — so the browser's visible tree is untouched and the old inode
is never removed.

This is textbook **Dropbox "Sync Engine Classic"**, which they rewrote precisely
because it *"represented moves as pairs of deletes… and adds"*, *"lacked a stable
identifier preserved across moves"*, and *"duplicates each directory"* on
conflict.

---

## Root cause, precisely

`ino` is minted by whoever creates a file:

- `storage.idb.ts` / DO SQLite: `crypto.randomUUID()`.
- `storage.fs.ts` (native): the **real OS inode**, `String(rootStat.ino)`, and it
  keeps a `pathMap: Map<Ino, string>` to translate ino→path for syscalls.

So the same logical path has a *different* `ino` on every backend. The sync wire
protocol ships those local inos as if they were shared identity.

### Current wire shapes (ino-keyed) — what crosses the wire today

From `packages/fs/storage.ts:43` / `:141` / `:147` / `:159`:

```ts
export type FsOp =
	| { kind: 'upsert-inode'; ino: Ino; meta?: Partial<InodeMeta>; xattrs?: Record<string, Uint8Array | null> }
	| { kind: 'set-dirent'; dirIno: Ino; name: string; ino: Ino; type: FileType }
	| { kind: 'unset-dirent'; dirIno: Ino; name: string; ino?: Ino }

export type ScanEntry = { ino: Ino; dirIno: Ino; name: string; meta: InodeMeta; xattrs?: Record<string, Uint8Array> }

interface StorageCapabilities {
	fullScan?(cursor): Promise<{ entries: ScanEntry[]; next: string; syncCursor?: string }>
	deltaUpdates?(cursor, opts?): Promise<{ ops: FsOp[]; cursor: string }>
	applyBatch?(ops: FsOp[], getBlob: (ino: Ino) => Promise<Uint8Array>, opts?): Promise<void>
}
```

`synced.ts` (`:107` push, `:143` pull, `:171` bootstrap) applies these verbatim on
the peer, trusting `ino` as shared identity. That is the bug.

---

## References (read these)

- **Dropbox — "Rewriting the heart of our sync engine" (Nucleus)** — local fs
  identity can't be the sync identity; stable IDs; "same view before mutating";
  move = delete+add is a trap; conflict-directory duplication.
  <https://dropbox.tech/infrastructure/rewriting-the-heart-of-our-sync-engine>
- **Syncthing FAQ** — path identity, `.sync-conflict` copies, "two independently-
  created folders don't merge unless you copy the Folder ID", rename handling.
  <https://docs.syncthing.net/users/faq.html>
- **Syncthing Block Exchange Protocol (BEP v1)** — index = `path → {version,
  blocks[]}`; content addressed by block hashes; version vectors for conflict.
  <https://docs.syncthing.net/specs/bep-v1.html>
- **Version vectors** (conflict detection between replicas).
  <https://en.wikipedia.org/wiki/Version_vector>
- **Git object model** — content-addressed blobs, path-addressed trees; the split
  we're adopting. <https://git-scm.com/book/en/v2/Git-Internals-Git-Objects>

Shared lesson: **the local inode stays local; the cross-replica identity is the
path (Syncthing) or a stable non-ino/non-path id (Dropbox).** Given frieren's
local-first stance and heterogeneous backends, **path** is the right identity.

---

## Design

### Two identity layers

| Layer | Identity | Where |
|---|---|---|
| Tree (dirs, names, meta) | **path** | new sync boundary |
| Content (bytes) | **content hash** (hex SHA-256) | already: R2 key `…/fs/blobs/sha256/<hash>` |
| Local inode | **`ino`** — local only, never crosses the wire | unchanged |

`ino` remains exactly as it is. It is used only to *detect* local changes and to
*address local storage*, never to identify a file to a peer.

### Wire shape (path-keyed)

The wire types are the **`/fs` sync-service contract**, so define them **schema-
first** (one canonical Zod schema) and `z.infer` the TS types the code uses — no
hand-written interface to drift from the schema. This lives once with the fs sync
service and is shared by both the local `SyncReplica` and the `/fs` HTTP layer.

```ts
// packages/fs (sync-wire contract) — the single source of truth.
// JSON-friendly encodings: bigint (mtimeNs/size) as strings, xattr bytes as base64.

// Canonical path: absolute, NFC, POSIX case-sensitive, '/'-separated, no empty
// segments, no '.'/'..', no trailing slash (except root '/'). This is the
// cross-replica identity, so the contract validates it — not bare z.string().
export const SyncPath = z.string().refine(isCanonicalPath, 'non-canonical path')

// Content identity = lowercase hex SHA-256 (64 chars), matching storage today
// (`sha256Hex`). The blob store addresses it under `…/fs/blobs/sha256/<hash>`;
// the hash itself is bare hex, NOT prefixed 'sha256-…'. Reject anything else.
export const ContentHash = z.string().regex(/^[0-9a-f]{64}$/)

export const SyncMeta = z.object({
	type: z.number(),                       // FileType: Regular | Directory | Symlink
	mode: z.number(),
	mtimeNs: z.string(),                    // bigint as string
	size: z.string(),                       // bigint as string
	// NO ctimeNs (intentional): ctime is POSIX-local — it records when THIS
	// replica's inode metadata last changed and cannot be set by userspace. The
	// applying replica sets ctime = apply-time locally; it never crosses the wire.
	symlinkTarget: z.string().optional(),
	// COMPLETE user-xattr snapshot for the path (name -> base64), never a patch.
	// Applying a `put` replaces the inode's entire user-xattr set with this map;
	// names absent from it are deleted locally. Omitted/empty = no user xattrs.
	// `trusted.sync.*` are local-only and are excluded from this map both ways.
	xattrs: z.record(z.string()).optional()
})

// A change to the tree, addressed by path. `contentHash` references a blob
// (undefined for dirs/symlinks). `version` drives generic LWW (see Conflicts).
// `source` = origin client-id, so a replica filters its own echoes on pull
// (same role as today's `MutationOptions.source` / `REMOTE_SOURCE`). On the PUSH
// endpoint `source` is NOT read from the body — the server stamps it from the
// authenticated request context (see /fs transport, #142.8).
export const PathChange = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('put'), path: SyncPath, version: z.number(),
	           source: z.string().optional(), contentHash: ContentHash.optional(),
	           meta: SyncMeta }),
	z.object({ kind: z.literal('delete'), path: SyncPath, version: z.number(),
	           source: z.string().optional() })
])

// Types the code uses are inferred, never re-declared.
export type SyncMeta = z.infer<typeof SyncMeta>
export type PathChange = z.infer<typeof PathChange>
```

The local `Storage` boundary converts between its native `InodeMeta` (`bigint`
sizes/times, `Uint8Array` xattrs) and this JSON-encoded `SyncMeta` — the same
encode/decode the HTTP layer needs, done once.

### The `SyncReplica` adapter (keep `Storage` lean — feedback #7)

Do **not** add path methods to `StorageCapabilities`. `Storage` stays the local
filesystem primitive. A separate adapter owns the path wire protocol; the local
and remote (HTTP) sides both implement it:

```ts
// A cursor is an opaque, monotonically increasing position in one replica's
// change stream: a SQLite/IDB journal `seq`, an NTFS USN, an FSEvents eventId,
// or a Syncthing `sequence`. Compared only for ordering.
export type SyncCursor = string

// The journaling seam every backend implements — how a replica reports what
// changed. The sync engine calls ONLY these two; it never learns the technique
// (write-intercept journal, OS change feed, or scan+diff — see Journaling).
export interface ChangeSource {
	// Path-changes strictly after `cursor` (empty = from the start), ordered,
	// capped at `limit`. `to` = cursor to persist; `done` = false if more pages
	// remain. `exclude` drops changes whose PathChange.source matches (echoes).
	// Deletes carry the removed path; a rename is delete(old) + put(new).
	pathDeltas(
		cursor: SyncCursor,
		opts?: { exclude?: string; limit?: number }
	): Promise<{ changes: PathChange[]; to: SyncCursor; done: boolean }>
	// A consistent full snapshot as `put`s (bootstrap). A snapshot's PAGINATION
	// position is NOT its sync high-water, so it returns BOTH (#142.1):
	//   - `next`: opaque token for the next snapshot page; undefined when `done`.
	//     Threaded straight back in as `pathScan(next)`.
	//   - `syncCursor`: the delta high-water captured ONCE at snapshot START and
	//     echoed on every page, so after the final page the caller resumes with
	//     `pathDeltas(syncCursor)` without gaps (idempotent overlap; see
	//     Scan/cursor). The `next` token also carries `syncCursor` internally so
	//     the snapshot stays pinned to one high-water across pages.
	pathScan(
		page?: SyncCursor,
		opts?: { limit?: number }
	): Promise<{ changes: PathChange[]; next?: SyncCursor; syncCursor: SyncCursor; done: boolean }>
}

// The full replica: a ChangeSource + apply + content transfer. Local (over a
// Storage/Volume) and remote (HTTP client) both implement it.
export interface SyncReplica extends ChangeSource {
	// Apply remote changes locally; fetch blobs by hash for regular-file puts.
	// `opts.source` tags the LOCAL write (e.g. REMOTE_SOURCE) for echo suppression
	// and volume.watch — distinct from PathChange.source, which is the ORIGIN
	// client-id used for pull-side filtering (feedback R2.3).
	applyPathChanges(
		changes: PathChange[],
		getBlobByHash: (h: string) => Promise<Uint8Array>,
		opts?: { source?: string }
	): Promise<void>
	// Content, addressed by hash (R2 already is).
	getBlobByHash(hash: string): Promise<Uint8Array>
	hasBlobByHash(hash: string): Promise<boolean>  // local presence check (see Lazy content)
	putBlobByHash?(hash: string, data: Uint8Array): Promise<void>  // remote only; see Blob push
}
```

- **Local adapter** wraps a `Storage`/`Volume`: `applyPathChanges` resolves paths
  to local inos (reusing existing ones — in-place — or minting fresh ones) and
  tags writes with `opts.source`; `pathDeltas` comes from the path journal below.
- **Remote adapter** is the HTTP client to `packages/core/src/fs.ts` new endpoints.
- `synced.ts` pulls with `applyPathChanges(changes, getBlobByHash, { source:
  REMOTE_SOURCE })` so `volume.watch` and echo suppression keep working, while
  `PathChange.source` (origin client-id) still drives `pathDeltas` filtering.

### Journaling / change detection (per-backend, behind `ChangeSource`)

Cross-replica identity is the **path**; each replica must report "what changed
since `cursor`" as ordered `PathChange`s. *How* it detects that is backend-
specific and hidden behind `ChangeSource`. Prior art gives three techniques (see
References — NTFS USN, macOS FSEvents, Syncthing BEP):

| technique | prior art | how | our backends |
|---|---|---|---|
| write-intercept journal | NTFS USN, Drive | append a durable, path-stamped row per mutation; cursor = `seq` | **SQLite (DO) + IDB (browser)** |
| OS change feed | FSEvents, USN | consume the platform's durable event stream; cursor = eventId | native (option) |
| scan + diff index | Syncthing | watch + scan, diff vs a persisted index; cursor = eventId/gen | **native (spud-mac)** |

**Invariant:** the change source lives **at/below `Storage`**, never only in a
`Volume` wrapper — otherwise a second `volume(storage)` or a direct backend/OS
write bypasses it. For owned backends the journal append is part of the mutation
transaction; for native the detector observes the real directory (watch + scan),
which external writers cannot bypass. Do **not** resolve inos against the *final*
tree — that loses deletes, renames, moves, and reused paths.

#### Owned backends — SQLite + IDB (identical strategy)

Both are engines we fully own: every mutation goes through our API, so we append
one **durable, append-only, path-stamped journal row per change, in the same
transaction** as the mutation. They differ only in the storage primitive, so the
logic is shared and each backend supplies a tiny `JournalStore`.

```ts
// A journal row = a PathChange plus its monotonic position. `seq` IS this
// backend's SyncCursor.
interface JournalRow { seq: number; change: PathChange }

// The only primitive a backend implements for the shared journal logic.
interface JournalStore {
	append(changes: PathChange[]): Promise<void>                 // within the mutation's txn
	readFrom(seq: number, limit: number): Promise<JournalRow[]>  // ordered by seq asc
	head(): Promise<number>                                      // latest seq (snapshot resume)
}

// Shared by SQLite + IDB — this is the whole ChangeSource for owned backends.
function journaledChangeSource(store: Storage, journal: JournalStore): ChangeSource {
	return {
		async pathDeltas(cursor, opts) {
			const limit = opts?.limit ?? PAGE
			const rows = await journal.readFrom(Number(cursor || '0'), limit)
			const changes = coalesceByPath(
				rows.map((r) => r.change).filter((c) => !opts?.exclude || c.source !== opts.exclude),
			)
			return { changes, to: String(rows.at(-1)?.seq ?? cursor ?? '0'), done: rows.length < limit }
		},
		async pathScan(page, opts) {
			// `page` is an opaque token carrying BOTH the tree-walk position and the
			// syncCursor frozen at scan START. First call (page undefined) freezes
			// syncCursor = journal.head() BEFORE walking; later pages carry it forward
			// so the whole snapshot shares one high-water. After the last page the
			// caller resumes pathDeltas(syncCursor) — no gaps (idempotent overlap).
			const { treePos, syncCursor } = page
				? decodeScanToken(page)
				: { treePos: undefined, syncCursor: String(await journal.head()) }
			const walk = await walkTreeAsPuts(store, treePos, opts?.limit ?? PAGE) // parent-before-child
			return {
				changes: walk.changes,
				next: walk.done ? undefined : encodeScanToken(walk.nextTreePos, syncCursor),
				syncCursor,
				done: walk.done,
			}
		},
	}
}
```

The two primitives are trivially different:

```ts
// SQLite (DO): a table + PK index; append inside the fs mutation transaction.
//   CREATE TABLE journal (
//     seq INTEGER PRIMARY KEY AUTOINCREMENT,
//     path TEXT NOT NULL, kind TEXT NOT NULL,          -- 'put' | 'delete'
//     version INTEGER NOT NULL, source TEXT,
//     content_hash TEXT, meta_json TEXT);              -- meta/hash NULL for delete
//   -- the per-path scalar version generator (#142.4), bumped in the SAME txn:
//   CREATE TABLE path_version (path TEXT PRIMARY KEY, version INTEGER NOT NULL);
//   append   -> INSERT ... (same txn as the mutation)
//   readFrom -> SELECT * FROM journal WHERE seq > ? ORDER BY seq LIMIT ?
//   head     -> SELECT COALESCE(MAX(seq), 0) FROM journal

// IDB (browser): an autoIncrement object store; append in the same IDB txn.
//   db.createObjectStore('journal', { keyPath: 'seq', autoIncrement: true })
//   db.createObjectStore('path_version', { keyPath: 'path' })   // version generator
//   append   -> for (row of rows) tx.objectStore('journal').add(row)
//   readFrom -> openCursor(IDBKeyRange.lowerBound(seq, /*open*/ true)), take limit
//   head     -> openCursor(null, 'prev').key ?? 0
//   NOTE: `dirs` today is indexed only by `dirIno` (children of a dir). Efficient
//   pathOf(ino) needs the REVERSE (child ino -> {dirIno,name}). Add a `by-ino`
//   index on `dirs` (or persist (parentIno,name) on the inode) so pathOf is
//   O(depth) index hops, not an O(N) scan (#142.5).
```

**Scalar `version` ownership (#142.4).** The per-path Lamport `version` lives
in the backend's `path_version` table and is bumped **transactionally with the
journal row**, so the journal is the single source of truth for what version each
change carries:

- **Local mutation** at path `p`: `v = COALESCE(path_version[p], 0) + 1`; write
  `path_version[p] = v` and the journal row `version = v` in the mutation txn.
- **Remote apply** (`applyPathChanges`, tagged `source = REMOTE_SOURCE`): set
  `path_version[p] = max(path_version[p], incoming.version)` (fast-forward the
  generator — never lower it, even if a stale/losing remote change arrives — so a
  later local edit yields `incoming.version + 1`, never restarts at 1). The row is
  still journaled but excluded from push by `source`.
- **Delete**: bump the version like any mutation and record it as the path's
  `tombstoneVersion` in `PathSyncState`; a later **recreate** at `p` starts from
  `max(path_version[p], tombstoneVersion) + 1`, so a resurrected path never sorts
  below its own tombstone.

`PathSyncState` (below) keeps the *agreed* `baselineVersion` for conflict
detection; `path_version` is the *generator*. They are distinct: the generator is
storage-internal and stamps outgoing changes; the baseline is engine-internal
(`/.state/sync-v2`) and decides winners on pull.

**Path stamping is O(depth), in-transaction.** When the mutation runs the tree is
consistent, so the backend resolves the path cheaply and stamps it into the row —
no in-memory tree index, no O(N) recompute on a cold Worker:

```ts
// putDirent(dir, name):    path = pathOf(dir) + '/' + name
// deleteDirent(dir, name): path = pathOf(dir) + '/' + name   (resolve BEFORE unlink)
// setMeta(ino) [content]:  path = pathOf(ino)
// pathOf walks parent dirents up to root — depth (~<20), not breadth. It needs a
// child→parent lookup (the `by-ino` index / stored parentIno above); without it
// pathOf would scan every dirent.
```

**Directory move / rename is journaled as an ordered subtree delete+put in ONE
txn (#142.5).** `atomicMove(oldDir,oldName → newDir,newName)` (and any
directory `putDirent` that relocates a subtree) enumerates the affected subtree at
mutation time and appends, within the same mutation transaction:

1. `delete` rows for every old path, **child-before-parent** (leaves first, so a
   peer applying them never orphans a live child under a deleted dir), then
2. `put` rows for every new path, **parent-before-child** (dir exists before its
   entries).

Enumeration uses the same `by-ino`/`dirIno` indexes as `pathOf`; the subtree is
walked once. This is disk-bound (one journal row per descendant) — a first-class
`move` op that ships a single rename is a later optimisation (see Renames). A
single-file rename is the degenerate case: one `delete(old)` + one `put(new)`.

This is the reviewer's option (A), but at the **storage layer** (not a bypassable
`Volume` wrapper), which is what makes it safe here.

#### Native fs (spud-mac) — scan + diff

A real directory can be written by other processes, so a write-intercept journal
would miss changes. Instead keep a **persisted local index** and detect changes by
watching + scanning (the Syncthing model):

```ts
// path -> last-agreed identity. Persisted (sidecar SQLite/LevelDB), NOT an in-RAM tree.
interface NativeIndexRow { path: string; contentHash: string; mtimeNs: bigint; size: bigint; version: number }

function nativeChangeSource(root: string, index: NativeIndex, watch: FsWatcher): ChangeSource {
	return {
		async pathDeltas(cursor, opts) {
			// cursor = last FSEvents/inotify eventId. Candidate paths = events since it.
			// For each: stat; if (mtimeNs,size) unchanged vs index -> skip (no re-hash);
			// else hash, emit put{path, meta, contentHash, version: ++}, update index.
			// In index but absent on disk -> emit delete (tombstone), drop from index.
			// `to` = latest eventId; `done` pages large bursts.
		},
		async pathScan(page, opts) {
			// full walk of `root` -> put[] (parent-before-child). syncCursor = the
			// eventId captured at scan START (frozen in `next` across pages) so a later
			// pathDeltas(syncCursor) resumes. Hash cache keyed by (path, mtimeNs, size).
		},
	}
}
```

Content hashing reads file bytes, so cache the hash by `(path, mtimeNs, size)` to
avoid re-hashing unchanged files. A periodic full scan is the backstop when the
watcher drops events.

#### Composition with `fs` / `Volume`

`Volume` (path API + `watch`) and `Storage` (ino-keyed primitive) are unchanged.
The journal/detector sits at the `Storage` layer; `synced()` drives a
`SyncReplica` built over it:

```
Volume  (readFile/writeFile/rename/watch)  ─uses─▶  Storage  (ino-keyed ops)
                                                     └─ owned backends: append JournalRow (same txn)
SyncReplica (path wire)  ─wraps─▶  Storage + ChangeSource(journal | scan-diff)
synced()  ─drives─▶  replica.pathDeltas / pathScan / applyPathChanges / *BlobByHash
```

`synced()` keeps two cursors under `/.state/sync-v2`: a **push** cursor over the
local `ChangeSource`, and a **pull** cursor over the remote's (the path-based
successors of today's `localCursor`/`remoteCursor`).

**Local-only paths (#142.6).** With the journal below `Storage`, writes to
`/.state/**` (sync cursors, client-id, `PathSyncState`) are themselves journaled.
The path model replaces today's `trusted.sync.local-only` xattr with a single
**hard path-prefix exclusion enforced in the local `SyncReplica`**:

- `pathDeltas` / `pathScan` **drop any change whose path is under `/.state/**`** so
  it is never pushed, and `applyPathChanges` **refuses to write under `/.state/**`**
  so a peer can never inject local state. This is a hard, path-level rule — not a
  per-inode flag — so it cannot be bypassed by a second `volume(storage)`.

That is the whole local-only story for v1: `/.state/**` is the only local-only
subtree the code actually has (today's marker is applied to `/.state` only). A
general user-facing “exclude this path from sync” feature does not exist and is not
in scope — add a registry only if/when such a feature is requested.

**Apply ordering & coalescing:** within a batch apply `put`s parent-before-child
and `delete`s child-before-parent; `coalesceByPath` collapses multiple ops on one
path to its final state. **Directory move** = ordered `delete(old subtree)` +
`put(new subtree)` in v1 (owned backends enumerate the subtree at rename time,
child-before-parent deletes then parent-before-child puts, in one txn — see
Directory move above; a first-class `move` op is a later optimisation).

### Blob push protocol (feedback #2)

Pull can `getBlobByHash` from the server. **Push cannot** — the server can't fetch
bytes from a browser by hash. Choose explicitly (this doc picks the second):

- inline changed-file bytes inside `POST /fs/path/changes` (like today's `/ops`
  which inlines regular-file content — `fs.client.ts:94`/`:296`), **or**
- **`PUT /fs/blob/:hash` first, then `POST /fs/path/changes`** referencing hashes.

The server **must verify `sha256(bytes) === hash`** before accepting a blob, and
reject a `put` whose `contentHash` has no stored blob. Small files may inline as
an optimisation; large files upload first.

**Orphaned-blob GC (feedback nit):** a `PUT /fs/blob/:hash` whose follow-up `POST
/fs/path/changes` never lands leaves an unreferenced blob. Because blobs are
content-addressed, a periodic sweep can drop any stored hash not referenced by a
live path `contentHash` (mark-and-sweep against the tree). Best-effort; no
correctness dependency.

### `/fs` transport (path-based endpoints)

The remote `SyncReplica` is the HTTP client for these; the DO serves them over its
local `SyncReplica`. The request/response bodies reuse the canonical `PathChange`
/ `SyncMeta` schema from **Wire shape** above (schema-first; the service just
imports it) — no separate wire types are declared here.

```ts
// packages/core/src/fs.ts — imports { PathChange } from the fs sync-wire contract.
// Deltas are one monotonic stream, so the page token IS the resume cursor.
const DeltaPage = z.object({
	changes: z.array(PathChange),
	to: z.string(),          // SyncCursor to persist AND next-page token (same seq)
	done: z.boolean()        // false => more pages remain
})
// Snapshot: pagination position and sync high-water are DISTINCT (#142.1).
const ScanPage = z.object({
	changes: z.array(PathChange),
	next: z.string().optional(),  // opaque next-page token; absent when done
	syncCursor: z.string(),       // delta high-water frozen at scan start; resume here
	done: z.boolean()
})
type DeltaPage = z.infer<typeof DeltaPage>
type ScanPage = z.infer<typeof ScanPage>
```

Endpoints (each maps to one `SyncReplica` method):

```
# PULL  (client reads the server's ChangeSource)
GET  /fs/path/changes?cursor=&exclude=&limit=   -> DeltaPage    # pathDeltas
GET  /fs/path/snapshot?page=&limit=             -> ScanPage     # pathScan (all puts)

# PUSH  (client writes path-changes; server applies to its Storage)
PUT  /fs/blob/:hash        body: raw bytes       -> 204          # putBlobByHash (verify sha256==hash)
POST /fs/path/changes      body: { changes }     -> 200          # applyPathChanges

# CONTENT  (hydration, both directions)
HEAD /fs/blob/:hash                              -> 200 | 404    # hasBlobByHash
GET  /fs/blob/:hash                              -> raw bytes    # getBlobByHash
```

- **Pull:** `GET /fs/path/changes?cursor` (bootstrap: `/fs/path/snapshot`, paged
  via `next`; on the final page persist `syncCursor` and resume `pathDeltas`
  there); for each `put`, hydrate content via `GET /fs/blob/:hash` (lazy on first
  read — see Lazy content). `exclude=<actorId>` drops the caller's own echoes.
- **Push:** `PUT /fs/blob/:hash` for new content (server verifies the hash), then
  `POST /fs/path/changes`; the handler applies to the DO's `Storage` and **rejects
  a `put` whose `contentHash` has no stored blob**. The handler **takes the origin
  client-id from the authenticated request context (session/header), not from
  per-change `PathChange.source` in the body** (#142.8), and stamps it on every
  applied change. This is robustness/defense-in-depth, not a cross-tenant security
  boundary: each DO is per-authenticated-user, so all callers are that user's own
  devices — a forged `source` could only make the user's own fleet mis-suppress
  echoes. The device id still originates client-side; the server just refuses to
  trust it per-change. `exclude=<actorId>` on pull is trusted because the server
  itself stamped that id on the way in.

These **replace and remove** the ino-keyed `/updates`, `/scan`, `/ops`,
`/inodes/:ino/blob` — deleted, not kept for debug (they only served ino-based
sync, which no longer exists).

### Conflicts & versioning

**One uniform policy for every path. The sync engine has no notion of app files
vs. user files — it never inspects paths like `/applications/**`.**

- Per-path `version` (a Lamport-style counter; generated in the backend's
  `path_version` table — see Scalar `version` ownership above — and its last-agreed
  value tracked per path in `PathSyncState.baselineVersion`).
- Conflict (both sides changed since baseline) → a **deterministic winner**, not
  strictly "last write": highest `version`, tie-broken by `(mtimeNs, contentHash)`
  (and for dirs/symlinks, which have no `contentHash`, by `(mtimeNs, path)` — the
  tie-break must be total for every node type). (For true LWW under concurrent
  equal-version writes, widen the key to a `(version, mtimeNs, actorId)` tuple —
  deferred; v1 only needs determinism.)
- **v1 conflict = LWW-by-version + log, everywhere. No conflict copies in v1.**
  The deterministic winner overwrites the loser and the overwrite is logged;
  `.sync-conflict` copies (preserve the loser, Syncthing-style, zero data loss)
  are the planned follow-up. This is uniform across steady-state **and** first
  bootstrap — bootstrap does not special-case a copy (see First-bootstrap policy),
  so v1 never has to build the conflict-copy machinery.

That's the whole conflict story at this layer.

### Out of scope: app-update / no-downgrade is a layer on top

The sync engine must **not** know that `/applications/**` are apps or that they
have a whole-bundle hash or a monotonic version. Deciding "this app has an update
/ don't downgrade / reinstall a changed bundle" is **higher-level logic that
observes file changes** and reconciles against the app catalog — it does not live
in, and is not called by, the sync loop.

Concretely (see [`docs/app-materialization.md`](./app-materialization.md)): a
materaliser/app-update watcher subscribes to `volume.watch` for changes under
`/applications/<id>/*` (from *any* source — a local edit or a synced-down pull),
recomputes the app's whole-bundle `.apphash`, and if it differs from the catalog
it reconciles **monotonically** (never downgrade) and quiesces the running app.
So if sync's uniform policy transiently lands a stale app bundle, this watcher
corrects it — the fix is *on top of* sync, using the file-change feed sync already
emits, never a special case *inside* sync.

### Path-keyed sync state + tombstones (feedback #4)

Baselines **cannot** live in inode xattrs — they vanish on delete/recreate, which
is exactly when tombstone conflict detection matters. Store sync state **by path**
(in `/.state/sync-v2`, itself local-only per the `/.state/**` exclusion above):

```ts
type PathSyncState = {
	path: string
	baselineVersion: number      // last version BOTH replicas agreed on at this path
	lastSeenHash?: string        // last agreed content hash (undefined for dirs/symlinks)
	tombstoneVersion?: number    // set when the path was deleted; survives recreate
}
```

This is the engine's conflict-detection record, **distinct from the backend's
`path_version` generator** (Scalar `version` ownership): `path_version` stamps the
next outgoing version; `baselineVersion` remembers the last agreed one so pull can
tell *fast-forward* (`remote.version > baseline`, `local` unchanged since baseline
→ accept) from *conflict* (both moved past `baseline` → deterministic winner).
On a delete, the engine also records `tombstoneVersion` here so a resurrected path
is versioned above its own tombstone.

### Lazy content: desired hash vs local presence (feedback #5)

Today lazy uses "missing local `contentHash`" as the stub marker and fetches by
ino (`synced.ts:388`/`:413`). For hash hydration the inode must **retain the
desired remote `contentHash`** (the content identity) while **blob presence is
tracked separately**:

- The inode's `contentHash` is always set from the `PathChange` (what we *should*
  have).
- "Do we have it locally" = the **content store holds a blob for that hash**. So
  the local content store becomes **content-hash-addressed** (or keeps a hash→
  presence index). This dedupes and matches R2.
- Lazy `readFile(path)`: `stat` → if the content store lacks `stat.contentHash`,
  `getBlobByHash(stat.contentHash)` and store it; else read local.

### Scan / cursor semantics (feedback #6)

`pathScan` returns TWO cursors (see `ChangeSource.pathScan`, #142.1): a `next`
page token to walk the snapshot, and a `syncCursor` **high-water frozen at scan
start over a stable snapshot**. After applying every page, the caller resumes with
`pathDeltas(syncCursor)`. `put`s are **idempotent** (put path=meta+hash), so
re-applying a write that landed both in the scan and the post-scan delta is
harmless. If a backend can't provide a stable snapshot, document the fallback:
capture `syncCursor` first, scan, then replay deltas-from-`syncCursor` (idempotency
covers overlap).

**Post-scan reconcile is by PATH, not ino (feedback nit):** after applying a full
`pathScan`, delete local paths **absent from the remote path snapshot** (the
adoption guard still gates whether reconcile runs at all — see First-bootstrap
policy). Today's `reconcileLocal` walks by ino; the path version deletes by path.

### First-bootstrap same-path policy

The adoption guard preserves a never-pushed profile's local work when it first
adopts a non-empty remote. Path identity makes the **same-path collision**
explicit: local (never-pushed) has `/x`, the remote snapshot also has `/x`.

**Policy (v1): keep local and bump its version so it wins the next push — no
conflict copy (#142.2, #142.3).** No app/user distinction. On a same-path
collision where content differs:

1. **Keep local** at `/x` (adoption's whole purpose: preserve never-pushed local
   work; local always wins).
2. **Bump the kept-local path's version** to `max(localVersion, remoteVersion) + 1`
   and set `PathSyncState.baselineVersion = remoteVersion`. Keeping local is not
   enough on its own: if remote `/x` is version 2 and never-pushed local `/x` is
   version 1, the next push would still lose. Bumping above the remote guarantees
   the subsequent push ships local up and wins deterministically.
3. **The remote loser is overwritten, not copied.** This matches steady-state LWW
   (v1 loses the loser everywhere); preserving it as `x (conflict <ts>)` is the
   same deferred follow-up as steady-state conflict copies — v1 does not build the
   copy machinery at bootstrap either.

If content is identical, nothing changes except reconciling both versions to the
higher of the two.

App bundles are not special-cased here. If this leaves a stale local app bundle,
the app-update watcher (a layer on top — see Out-of-scope above) recomputes the
whole-bundle hash against the catalog and reconciles monotonically. The sync
engine neither knows nor cares.

### Renames

v1: **delete + put** (correct under path identity). Rename *detection* (match a
delete+put by identical `contentHash` to preserve local ino) is a later
optimisation; the blob is content-addressed so it isn't re-uploaded regardless.

### Migration / self-heal (feedback #8)

- **New state key.** Do not reuse the ino cursors under `/.state/sync`. Persist
  path sync state under **`/.state/sync-v2`** so the first path-based release
  forces a fresh `pathScan` bootstrap instead of trusting stale ino cursors.
- Existing forked replicas converge on that first bootstrap (path is now the
  identity; the server's `/applications/*` wins by path).

---

## Where the changes land (focused)

Contained to `packages/fs` + the `packages/core` fs transport; **kernel/apps
untouched**.

1. `packages/fs` — add `SyncMeta` / `PathChange` types and the **`SyncReplica`**
   interface. Add a **local `SyncReplica`** over `Volume`/`Storage`
   (`applyPathChanges`, `pathScan`, path journal per "Journaling"). `Storage`
   itself gains only a minimal ordered **path-delta source** (the journal), not
   the wire protocol.
2. `packages/fs/synced.ts` — `push`/`pull`/`bootstrap` operate on `PathChange`
   via `SyncReplica`; state under `/.state/sync-v2`, keyed by path
   (`PathSyncState` + tombstones); lazy `readFile` hydrates by `contentHash`.
3. `packages/core/src/fs.ts` — path-based endpoints per **`/fs` transport** above
   (`GET /fs/path/changes`, `GET /fs/path/snapshot`, `POST /fs/path/changes`,
   `PUT`/`GET`/`HEAD /fs/blob/:hash`). **Remove** the ino-keyed `/updates`,`/scan`,
   `/ops`,`/inodes/:ino/blob` entirely (they only served ino-based sync).
4. `storage.fs.ts` (native) — reference backend proving ino stays a real-OS
   concept. Full participation needs content hashing + a path journal/delta source
   (future; see nits).

Non-goals for v1: version vectors, rename detection, user-file conflict copies,
partial-block transfer (whole blobs, keyed by hash; R2 dedupes).

---

## Development phases

This change is built in three deliberate phases. Do **not** collapse them — the
point is to lock the *shape* before implementing, and to have failing tests
before writing code.

### Phase 0 — shape only (scaffold, fully wired, deliberately broken)

Write **only** the surface, no working bodies:

- All **types + Zod schemas** (`SyncMeta` / `PathChange` / `SyncPath` /
  `ContentHash` / `DeltaPage` / `ScanPage`, `SyncCursor`, `JournalRow`,
  `PathSyncState`).
- All **interfaces** (`ChangeSource`, `SyncReplica`, `JournalStore`, the native
  index/watcher seams).
- Every concrete implementation body **throws `Error('not implemented')` and is
  marked `// TODO(path-sync): …`**. Nothing actually works.
- **Hook it up completely** — wire the new `SyncReplica`/`ChangeSource` into
  `synced.ts`, the backends, and the `/fs` endpoints as if they were done.

This **breaks the running system, and that's expected.** The goal is to review
the *shape in situ* — how the new concepts are actually called and composed — so
we can spot awkward seams and tweak the design before any real code. **Phase 0 is
done only when we all agree on the shape.** No behaviour, no tests yet.

Exit criteria: it typechecks; every seam is wired; every unimplemented body is a
`TODO` that throws; a design review sign-off.

### Phase 1 — tests first (all red)

This change is unusually unit-test-friendly *and* complex/error-prone, so we want
**maximum coverage before implementing**:

- Write the RED tests from **Verification** below (RED 1–13) plus the
  deterministic property test.
- Cover the **major edge cases** explicitly: rename, directory move (subtree
  delete+put across a page boundary), parent-dir delete, path reuse/replacement,
  type replacement (file↔dir with recursive delete ordering), tombstone then
  recreate, echo suppression, snapshot paging + `pathDeltas(syncCursor)` resume
  with no gaps, idempotent scan/delta overlap, adoption same-path (incl.
  higher-remote-version), `/.state/**` never crossing the wire, equal-version
  concurrent writes with equal/near-equal mtimes (deterministic tie-break for
  dirs/symlinks too), bigint/base64 wire round-trip, lazy hydrate-by-hash.
- **Build test infra** where it helps: an in-memory `SyncReplica` harness,
  `twoPeers()` / `adoptionPeers()`, a numeric-ino backend, a seedable
  deterministic op generator.

At this stage **every test fails (red), and that's expected** — the Phase 0 bodies
still throw. Exit criteria: the suite is comprehensive and agreed; all red for the
right reason (`not implemented`), not from harness bugs.

### Phase 2 — implement until green

Bring the system online **one `TODO` at a time**, turning red tests green, until
the whole suite (RED 1–13 + property test) and the **Definition of done** pass.
No new surface area here — only filling in the bodies agreed in Phase 0 against the
tests written in Phase 1.

Exit criteria: all tests green; DoD satisfied; the incident (RED 1) is
reproduced-then-fixed.

---

## Spec nits to lock before coding (feedback)

- **Path normalization:** absolute paths only; normalise slashes; reject `..`;
  define Unicode normalisation + case sensitivity (recommend: NFC, case-
  sensitive, matching POSIX). Encoded once as the `SyncPath` schema (Wire shape).
- **Content hash format:** one canonical form — lowercase hex SHA-256 (64 chars),
  the `ContentHash` schema; blob store addresses it under `…/fs/blobs/sha256/`.
  Reject `sha256-`-prefixed or non-hex values.
- **`SyncMeta.ctimeNs`:** intentionally omitted — ctime is POSIX-local; the
  applying replica sets it to apply-time and it never crosses the wire.
- **xattr semantics:** `SyncMeta.xattrs` is a COMPLETE snapshot, not a patch;
  apply replaces the whole user-xattr set; `trusted.sync.*` excluded both ways.
- **Push `source` untrusted:** the server stamps `PathChange.source` from the
  authenticated request context, not the body, on `POST /fs/path/changes` (#142.8)
  — robustness within a user's own device fleet (each DO is per-user), not a
  cross-tenant boundary.
- **Local-only paths:** one hard `/.state/**` path-prefix exclusion in the local
  `SyncReplica` (never pushed, never applied) (#142.6) — replaces the
  `trusted.sync.local-only` xattr. No general user local-only feature in v1.
- **Apply ordering:** puts parent-before-child; deletes child-before-parent.
- **Type replacement:** define file↔dir replacement at a path (delete subtree
  then put) and recursive delete behaviour.
- **Echo suppression:** `PathChange.source` carries client-id; `pathDeltas`
  supports `sourceMode: 'exclude'` so a replica skips its own echoes (parity with
  today's source filtering).
- **Native backend:** path identity unblocks the model, but native still needs
  content hashing and a path journal/delta source before it can push (it has no
  journal today). Track as a follow-up.
- **Hard links:** the VFS states hard links are unsupported; if a native backend
  ever exposes two paths for one OS inode, path sync treats them as two
  independent paths (content-addressed blob shared). Document this.

---

## Verification: red → green (TDD)

Tests in `packages/fs/synced.test.ts` (extend the mem-storage harness). Each RED
fails against today's ino-based sync; must pass (GREEN) after the change. Run
`pnpm vitest run packages/fs/synced.test.ts`.

Helper `twoPeers()` builds two independent `Storage` backends (each mints its own
inos) behind local+remote `SyncReplica`s and a sync pump.

### RED 1 — the fork heals (generic path identity, no app semantics; feedback R2.4)

Keep fs-sync tests free of app-materialiser policy. Seed **explicit path
versions** in the fake `SyncReplica` harness; app-version/no-downgrade lives in
`docs/app-materialization.md`.

```ts
test('same path independently created on both sides converges by path version', async () => {
	const { client, server, syncBoth } = twoPeers()
	// Same PATH, DIFFERENT local inos, DIFFERENT explicit path versions.
	await server.write('/x/f', bytes('S'), { version: 2 })
	await client.write('/x/f', bytes('C'), { version: 1 })
	await syncBoth()
	// Deterministic winner = higher path version, on both replicas. One entry.
	expect(text(await client.readFile('/x/f'))).toBe('S')
	expect((await client.readdir('/x')).map((e) => e.name)).toEqual(['f'])
})
```
RED today: client keeps its own ino/content; the server's op lands on a phantom
parent and never converges.

### RED 2 — heterogeneous ino spaces sync (unblocks spud-mac)

```ts
test('syncs between a numeric-ino and a uuid-ino backend, both behind SyncReplica', async () => {
	// Two backends implementing SyncReplica; inos are backend-local and disjoint.
	// (Real nativeStorage still needs content hashing + a path delta source first
	// — see Native backend nit; here we use a numeric-ino mem backend.)
	const native = memStorage({ mintIno: numericIno })  // "2","3",… like OS inodes
	const uuid   = memStorage({ mintIno: uuidIno })
	const { syncBoth } = wire(native, uuid)
	await native.writeFile('/data/note.txt', bytes('hello'))
	await syncBoth()
	expect(text(await uuid.readFile('/data/note.txt'))).toBe('hello')  // arrives by PATH
})
```

### RED 3 — in-place update keeps the local ino (feedback: assert ino stability)

```ts
test('updating content at a path reuses the local inode and converges', async () => {
	const { client, server, syncBoth } = twoPeers()
	await server.writeFile('/applications/app.code/gui.js', bytes('v1')); await syncBoth()
	const inoBefore = (await client.stat('/applications/app.code/gui.js')).ino
	await server.writeFile('/applications/app.code/gui.js', bytes('v2')); await syncBoth()
	expect(text(await client.readFile('/applications/app.code/gui.js'))).toBe('v2')
	expect((await client.stat('/applications/app.code/gui.js')).ino).toBe(inoBefore) // in-place
	expect(await orphanCount(client)).toBe(0)
})
```

### RED 4 — delete propagates by path, across a divergent tree (feedback)

```ts
test('deleting a path removes it on a peer that had a DIVERGENT local subtree', async () => {
	const { client, server, syncBoth } = twoPeers()
	// Make them divergent first (different inos at the same path), else a plain
	// bootstrap-then-delete would pass trivially.
	await server.writeFile('/applications/x/app.js', bytes('S'))
	await client.writeFile('/applications/x/app.js', bytes('C'))
	await syncBoth()                                   // converge by path
	await server.rm('/applications/x', { recursive: true }); await syncBoth()
	expect(await client.exists('/applications/x')).toBe(false)
})
```

### RED 5 — no-downgrade is NOT a sync test

The sync engine has no downgrade concept — it's uniform LWW. "Never downgrade an
app" is a **materialiser** test: see `docs/app-materialization.md` RED 2. The only
sync-level guard is that deltas apply in causal order (covered by the property
test); there is no app logic here.

### RED 6 — lazy content hydrates by hash, stub retains desired hash (feedback #5)

```ts
test('pulled file is a stub carrying the desired hash; first read hydrates by hash', async () => {
	const { client, server, syncBoth } = twoPeers({ lazyContent: true })
	await server.writeFile('/applications/app.code/gui.js', bytes(BIG)); await syncBoth()
	const st = await client.stat('/applications/app.code/gui.js')
	expect(st.contentHash).toBe(sha256(BIG))               // stub remembers what to fetch
	expect(await client.hasLocalBlob(st.contentHash)).toBe(false)
	expect(text(await client.readFile('/applications/app.code/gui.js'))).toBe(BIG) // getBlobByHash
	expect(await client.hasLocalBlob(st.contentHash)).toBe(true)
})
```

### RED 7 — first-bootstrap same-path policy (uniform, app-agnostic)

```ts
test('adoption bootstrap: keep local and version it to win; remote loser overwritten (any path)', async () => {
	// Never-pushed local profile already has the path; remote snapshot differs.
	const { local, remote, bootstrapLocalFromRemote, syncBoth } = adoptionPeers()
	await local.writeFile('/notes/todo.md', bytes('LOCAL'))   // unpushed local work
	await remote.writeFile('/notes/todo.md', bytes('REMOTE'))
	await bootstrapLocalFromRemote()
	expect(text(await local.readFile('/notes/todo.md'))).toBe('LOCAL')      // adoption keeps local
	await syncBoth()
	expect(text(await remote.readFile('/notes/todo.md'))).toBe('LOCAL')     // local pushed up and won
})
```
No conflict copy is asserted — v1 loses the remote loser everywhere (see
Conflicts). Preserving it as `todo.md (conflict)` is the deferred follow-up.
App bundles are not tested here — they follow the same uniform rule. "Stale app
bundle gets reconciled to newest" is a **materialiser** test
(`docs/app-materialization.md`), driven by the app-update watcher on top of sync.

### RED 8 — snapshot pages, then `pathDeltas(syncCursor)` resumes with no gaps (#142.1)

```ts
test('bootstrap pages through pathScan then resumes deltas from syncCursor', async () => {
	const { client, server, bootstrap } = twoPeers()
	for (let i = 0; i < 250; i++) await server.writeFile(`/d/f${i}`, bytes(String(i)))
	// page through the snapshot (small limit) while the server keeps mutating.
	const pages = await bootstrap({ limit: 100 })          // uses next until done
	await server.writeFile('/d/f0', bytes('changed-after-snapshot-start'))
	await client.pullFrom(pages.syncCursor)                // resume deltas at frozen high-water
	expect((await client.readdir('/d')).length).toBe(250) // no gaps, no dupes
	expect(text(await client.readFile('/d/f0'))).toBe('changed-after-snapshot-start')
})
```

### RED 9 — adoption where remote version is higher: local kept, then pushes and wins (#142.3)

```ts
test('adoption keeps local over a higher-version remote and the next push wins', async () => {
	const { local, remote, bootstrapLocalFromRemote, syncBoth } = adoptionPeers()
	await remote.write('/x', bytes('REMOTE'), { version: 2 }) // higher remote version
	await local.write('/x', bytes('LOCAL'), { version: 1 })   // never-pushed local
	await bootstrapLocalFromRemote()                          // keeps local, bumps > 2
	await syncBoth()
	expect(text(await remote.readFile('/x'))).toBe('LOCAL')   // local pushed up and won
})
```

### RED 10 — `/.state/**` never crosses the wire (#142.6)

```ts
test('local state under /.state is never pushed or applied', async () => {
	const { client, server, syncBoth, pushedChanges } = twoPeers()
	await client.writeFile('/notes/a', bytes('hi')); await syncBoth()
	// clientid + sync-v2 cursors were written to /.state during the cycle:
	expect(pushedChanges().some((c) => c.path.startsWith('/.state/'))).toBe(false)
	expect(await server.exists('/.state')).toBe(false)       // server never got it
})
```

### RED 11 — directory rename with children across a page boundary (#142.5)

```ts
test('renaming a directory moves every descendant, even across delta pages', async () => {
	const { client, server, syncBoth } = twoPeers()
	for (let i = 0; i < 150; i++) await server.writeFile(`/old/f${i}`, bytes(String(i)))
	await syncBoth()
	await server.rename('/old', '/new'); await syncBoth({ limit: 50 }) // force multi-page
	expect(await client.exists('/old')).toBe(false)          // old subtree fully gone
	expect((await client.readdir('/new')).length).toBe(150)  // new subtree complete
	expect(text(await client.readFile('/new/f42'))).toBe('42')
})
```

### RED 12 — type replacement at a path (file↔dir), recursive delete ordering

```ts
test('replacing a file with a dir (and back) converges with correct delete ordering', async () => {
	const { client, server, syncBoth } = twoPeers()
	await server.writeFile('/p', bytes('file')); await syncBoth()
	await server.rm('/p'); await server.mkdir('/p'); await server.writeFile('/p/child', bytes('c'))
	await syncBoth()
	expect((await client.stat('/p')).type).toBe(FileType.Directory)
	expect(text(await client.readFile('/p/child'))).toBe('c')
	// and back: dir -> file (recursive delete of subtree before the put)
	await server.rm('/p', { recursive: true }); await server.writeFile('/p', bytes('file2'))
	await syncBoth()
	expect((await client.stat('/p')).type).toBe(FileType.Regular)
	expect(text(await client.readFile('/p'))).toBe('file2')
})
```

### RED 13 — equal-version tie-break is deterministic for every node type

```ts
test('concurrent equal-version writes pick the SAME deterministic winner on both sides', async () => {
	const { client, server, syncBoth } = twoPeers()
	// equal version, equal mtime: tie-break must be total (contentHash for files,
	// path for dirs/symlinks) so both replicas independently agree.
	await server.write('/f', bytes('S'), { version: 5, mtimeNs: '100' })
	await client.write('/f', bytes('C'), { version: 5, mtimeNs: '100' })
	await server.mkdir('/d', { version: 5, mtimeNs: '100' })
	await client.mkdir('/d', { version: 5, mtimeNs: '100' })
	await syncBoth()
	expect(text(await client.readFile('/f'))).toBe(text(await server.readFile('/f')))
	expect((await client.stat('/d')).ino !== undefined).toBe(true) // dir tie also resolves
})
```

### GREEN — guardrails to keep

- Existing `synced.test.ts` cases (push/pull/bootstrap/adoption/lazy) still pass,
  rewritten to the path API.
- **Property test** (deterministic-seeded, à la Nucleus): random
  `writeFile/rm/rename/mkdir` on two peers, sync, assert **both trees byte-
  identical by path** and **zero orphaned inodes**. Frieren's small volumes make
  this cheap.

---

## Definition of done (feedback)

Before implementation is considered ready:

- Path changes are **journaled or translated with historical path/tombstone
  correctness** — not resolved against final tree state.
- Push **uploads blobs by hash and the server verifies** them.
- **The sync engine is uniform and app-agnostic** — one conflict policy for every
  path; it never inspects `/applications/**` or app versions. App update /
  no-downgrade is explicitly a **layer on top** that watches file changes
  (`docs/app-materialization.md`), not a special case inside sync.
- **Baselines/tombstones are stored by path** (`PathSyncState`), not inode xattrs;
  the scalar `version` **generator lives in the backend `path_version` table**,
  bumped transactionally with the journal row (#142.4).
- **`applyPathChanges` carries a local-apply `source`** (e.g. `REMOTE_SOURCE`),
  distinct from `PathChange.source` (origin client-id) — echo suppression and
  `volume.watch` preserved. On push the server takes `source` from the
  authenticated request context, not the body (#142.8).
- **The path journal lives at/below `Storage`** (not a bypassable `Volume`
  wrapper), translated to path-correct deltas with tombstones. **Directory move =
  ordered subtree delete+put in one txn**, needing a child→parent index for
  `pathOf` (#142.5).
- **Local-only state is excluded by path** — one hard `/.state/**` prefix rule in
  the local `SyncReplica`, replacing the `trusted.sync.local-only` xattr (#142.6);
  never pushed, never applied. No general user local-only feature in v1.
- **First-bootstrap same-path policy defined & tested** — keep local **and bump
  kept-local version above the remote** so the next push wins (#142.2/#142.3); the
  remote loser is overwritten, not copied — uniform with steady-state LWW.
- **Conflict = LWW-by-version + log everywhere in v1; no conflict copies** (steady
  state or bootstrap). `.sync-conflict` copies are the deferred follow-up (#142.2).
- **Lazy stubs retain the remote content hash** while separately tracking local
  blob presence (`hasBlobByHash`).
- **`pathScan` returns split cursors** — a `next` page token AND a `syncCursor`
  high-water frozen at scan start; documented and tested (paged bootstrap resumes
  `pathDeltas(syncCursor)` with no gaps; idempotent apply; post-scan reconcile
  deletes by **path**, not ino) (#142.1).
- **Migration forces a `/.state/sync-v2` bootstrap.**
- **Wire schema locked** — `SyncPath`/`ContentHash` schemas (not bare strings),
  `ctimeNs` intentionally omitted (synthesised on apply), `xattrs` a complete
  snapshot not a patch (#142.7).
- **Spec nits resolved** (normalization, content-hash format, apply ordering, type
  replacement, echo suppression, native caveats, hard links, orphaned-blob GC).
- Conflict resolution documented as a **deterministic winner** (not strict LWW for
  concurrent equal-version writes), with a **total tie-break for every node type**
  (files by `contentHash`, dirs/symlinks by `path`).
- RED 1–13 pass (RED 5 in the materialiser doc), plus the deterministic property
  test.

---

## Sequencing

1. Ship the single-materialiser fix first (see
   [`docs/app-materialization.md`](./app-materialization.md)) — removes the
   common-case fork under today's ino sync.
2. This doc: path-based sync — makes forks structurally impossible and unblocks
   heterogeneous-backend sync (spud-mac ↔ frieren). It is a prerequisite for that
   roadmap, not gold-plating.

## Decisions (resolved)

- **Version = scalar Lamport for v1.** Version vectors (true concurrency
  detection) are a later upgrade. App-update policy stays entirely in the
  materialiser layer, not the sync engine.
- **Conflict = LWW-by-version + log for v1, everywhere (steady-state AND
  bootstrap). No conflict copies in v1.** `.sync-conflict` copies (zero data loss,
  Syncthing-style) are the planned follow-up — deferred uniformly so v1 never
  builds the copy machinery (#142.2).
- **Adoption bumps kept-local version above the remote** so the next push wins,
  and records `baselineVersion = remoteVersion` (#142.3).
- **Remove the ino-keyed HTTP sync endpoints** (`/updates`, `/scan`, `/ops`,
  `/inodes/:ino/blob`) — deleted, not retained for debug.
