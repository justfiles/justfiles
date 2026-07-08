# Path-based sync for `@justfiles/fs`

Status: design spec. No code yet.

## Overview

`packages/fs/synced.ts` reconciles two replicas by **inode id (`ino`)**. An `ino`
is a *local* identity — it means nothing on another machine. Using it as the
*cross-replica* identity causes two failures:

1. **Forking.** When two replicas independently create the same path (e.g. the
   client seeds `/applications/app.code` and the server also materialises it),
   they mint different inos for the same path. Neither side's ops address the
   other's inos, so the change lands in an unreachable subtree and never
   converges — while sync reports "synced".
2. **Heterogeneous backends cannot sync.** The native backend (`storage.fs.ts`)
   uses **real OS inode numbers**; IDB/DO use UUIDs. Their ino spaces are disjoint,
   so ino-based sync between a native replica and the frieren backend is
   structurally impossible.

**Fix:** make the **sync boundary path-addressed**. The tree is identified by
**path**, blobs by **content hash** (already true in R2). `ino` stays a purely
local identity (correct fs modelling: hard links, fast `mv`, native passthrough).
A new **`SyncReplica`** adapter owns the path wire protocol; `Storage` stays the
lean local-fs primitive.

### Root cause

`ino` is minted by whoever creates a file:

- `storage.idb.ts` / DO SQLite: `crypto.randomUUID()`.
- `storage.fs.ts` (native): the **real OS inode**, `String(rootStat.ino)`, with a
  `pathMap: Map<Ino, string>` to translate ino→path for syscalls.

So the same logical path has a *different* `ino` on every backend, and the current
ino-keyed wire ships those local inos as if they were shared identity:

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

`synced.ts` (push/pull/bootstrap) applies these verbatim on the peer, trusting
`ino` as shared identity. That is the bug.

---

## Design

### Two identity layers

| Layer | Identity | Where |
|---|---|---|
| Tree (dirs, names, meta) | **path** | new sync boundary |
| Content (bytes) | **content hash** (hex SHA-256) | already: R2 key `…/fs/blobs/sha256/<hash>` |
| Local inode | **`ino`** — local only, never crosses the wire | unchanged |

`ino` is used only to *detect* local changes and *address local storage*, never to
identify a file to a peer.

**Hard links:** the VFS states hard links are unsupported. If a native backend ever
exposes two paths for one OS inode, path sync treats them as two independent paths
(sharing one content-addressed blob).

### Wire schema (path-keyed)

The wire types are the **`/fs` sync-service contract**, defined **schema-first**
(one canonical Zod schema, `z.infer` the TS types) so there is no hand-written
interface to drift. This lives once with the fs sync service and is shared by the
local `SyncReplica` and the `/fs` HTTP layer. JSON encodings: bigint
(`mtimeNs`/`size`) as strings, xattr bytes as base64.

```ts
// Canonical path: absolute, NFC, POSIX case-sensitive, '/'-separated, no empty
// segments, no '.'/'..', no trailing slash (except root '/'). This is the
// cross-replica identity, so the contract validates it — not bare z.string().
export const SyncPath = z.string().refine(isCanonicalPath, 'non-canonical path')

// Content identity = lowercase hex SHA-256 (64 chars), matching `sha256Hex`. The
// blob store addresses it under `…/fs/blobs/sha256/<hash>`; the hash itself is
// bare hex, NOT prefixed 'sha256-…'. Reject anything else.
export const ContentHash = z.string().regex(/^[0-9a-f]{64}$/)

// Per-path Lamport version. DECIMAL STRING on the wire (like mtimeNs/size), NOT
// z.number(): avoids the 2^53 ceiling and can widen to bigint without a wire
// change. Persisted/internal versions (`path_version`, `PathSyncState`,
// `NativeIndexRow`) are v1-bounded integers; the string is the wire boundary only.
// COMPARE NUMERICALLY, never lexicographically — else "10" sorts below "9".
export const Version = z.string().regex(/^(0|[1-9][0-9]*)$/)

export const SyncMeta = z.object({
	type: z.enum(FileType),                  // Regular | Directory | Symlink — enum, not any number
	mode: z.number().int(),
	mtimeNs: z.string(),                    // bigint as string
	size: z.string(),                       // bigint as string
	// NO ctimeNs (intentional): ctime is POSIX-local and cannot be set by userspace.
	// The applying replica sets ctime = apply-time locally; it never crosses the wire.
	symlinkTarget: z.string().optional(),
	// COMPLETE user-xattr snapshot for the path (name -> base64), never a patch.
	// Apply replaces the inode's entire user-xattr set; names absent from it are
	// deleted locally. Omitted/empty = no user xattrs. `trusted.sync.*` are
	// local-only and excluded from this map both ways.
	xattrs: z.record(z.string()).optional()
})

// A change to the tree, addressed by path. `version` drives generic LWW (see
// Conflicts). `source` = ORIGIN client-id, so a replica filters its own echoes on
// pull. It is SERVER-AUTHORITATIVE in the star topology: on the PUSH endpoint
// `source` is NEVER read from the body — the server stamps every change with the
// caller's client-id from the authenticated request (header/session). See
// Topology, trust & authority.
//
// `contentHash` invariants are SCHEMA-ENFORCED: a regular-file put MUST carry a
// hash (empty files included — SHA-256 of empty bytes, e3b0c442…b855) so every
// regular file is hydratable; dirs/symlinks MUST NOT carry one. The root `/` is
// never a change subject: `put('/')` and `delete('/')` are both rejected here.
export const PathChange = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('put'), path: SyncPath, version: Version,
	           source: z.string().optional(), contentHash: ContentHash.optional(),
	           meta: SyncMeta }),
	z.object({ kind: z.literal('delete'), path: SyncPath, version: Version,
	           source: z.string().optional() })
]).superRefine((c, ctx) => {
	if (c.path === '/')
		ctx.addIssue({ code: 'custom', message: 'root / is never a PathChange subject' })
	if (c.kind !== 'put') return
	const isRegular = c.meta.type === FileType.Regular
	if (isRegular && !c.contentHash)
		ctx.addIssue({ code: 'custom', message: 'regular-file put requires contentHash' })
	if (!isRegular && c.contentHash)
		ctx.addIssue({ code: 'custom', message: 'dir/symlink put must not carry contentHash' })
})

export type SyncMeta = z.infer<typeof SyncMeta>
export type PathChange = z.infer<typeof PathChange>
```

The local `Storage` boundary converts between its native `InodeMeta` (`bigint`
sizes/times, `Uint8Array` xattrs) and this JSON-encoded `SyncMeta` — the same
encode/decode the HTTP layer needs, done once.

### The `SyncReplica` adapter (keep `Storage` lean)

Do **not** add path methods to `StorageCapabilities`. A separate adapter owns the
path wire protocol; the local and remote (HTTP) sides both implement it.

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
	// remain. Deletes carry the removed path; a rename is delete(old) + put(new).
	//
	// TWO independent echo filters, because a journal row has TWO source concepts:
	// `excludeOrigin` drops changes whose ORIGIN client-id (the cross-replica
	// `PathChange.source`) matches — used by REMOTE pull to skip this client's own
	// authored changes; `excludeLocalSource` drops rows whose LOCAL apply source
	// matches (e.g. `REMOTE_SOURCE`) — used by LOCAL push to skip changes the sync
	// layer itself applied from a pull. Not interchangeable; both are needed.
	pathDeltas(
		cursor: SyncCursor,
		opts?: { excludeOrigin?: string; excludeLocalSource?: string; limit?: number }
	): Promise<{ changes: PathChange[]; to: SyncCursor; done: boolean }>
	// A consistent full snapshot as `put`s (bootstrap). A snapshot's PAGINATION
	// position is NOT its sync high-water, so it returns BOTH:
	//   - `next`: opaque token for the next snapshot page; undefined when `done`.
	//   - `syncCursor`: the delta high-water captured ONCE at snapshot START and
	//     echoed on every page, so after the final page the caller resumes with
	//     `pathDeltas(syncCursor)` without gaps (idempotent overlap). The `next`
	//     token also carries `syncCursor` internally so the snapshot stays pinned
	//     to one high-water across pages.
	pathScan(
		page?: SyncCursor,
		opts?: { limit?: number }
	): Promise<{ changes: PathChange[]; next?: SyncCursor; syncCursor: SyncCursor; done: boolean }>
}

// SyncReplica is a COMPOSITION of three orthogonal role interfaces, NOT an
// inheritance hierarchy. ChangeSource (detection) has several concrete strategies
// (journaled | native | OS-feed) and can stand alone (e.g. a read-only change
// observer / indexer). A local replica COMPOSES an injected ChangeSource and adds
// ChangeApplier + BlobStore over its Storage; the remote HTTP replica implements
// all three facets inline. The split follows the source/target asymmetry: on push
// the SOURCE side needs ChangeSource + BlobStore.get, the TARGET side needs
// ChangeApplier + BlobStore.put — blobs (content-addressed, both directions)
// belong to neither exclusively, hence their own role.

// Apply remote path-changes locally (the write/target side of a replica).
export interface ChangeApplier {
	// `opts.source` tags the LOCAL write (e.g. REMOTE_SOURCE) — it becomes the
	// journal row's `localSource` for push suppression and drives volume.watch. It
	// is distinct from PathChange.source, the ORIGIN client-id used for pull-side
	// `excludeOrigin` filtering.
	//
	// Content handling is explicit: a regular-file put either
	//   - EAGER: `getBlobByHash(contentHash)` now and store it, or
	//   - LAZY:  write a stub that RETAINS `contentHash` and skip the fetch;
	//            readFile hydrates on first access (see Lazy content).
	// The mode is fixed per local replica at construction (`lazyContent`), so
	// `getBlobByHash` is only invoked in eager mode.
	applyPathChanges(
		changes: PathChange[],
		getBlobByHash: (h: string) => Promise<Uint8Array>,
		opts?: { source?: string }
	): Promise<void>
}

// Hash-addressed content transfer, both directions (R2 already is).
export interface BlobStore {
	getBlobByHash(hash: string): Promise<Uint8Array>
	hasBlobByHash(hash: string): Promise<boolean>  // local presence check (see Lazy content)
	// Store a blob in THIS replica's hash-addressed blob store. Local adapter: writes
	// the backend content store (eager pull + lazy hydration). Remote adapter: PUT
	// /fs/blob/:hash (push). Content is materialised HERE, never inside applyJournaled.
	putBlobByHash(hash: string, data: Uint8Array): Promise<void>
}

// The full replica: detection + apply + content, COMPOSED (not inherited). Local
// (over a Storage/Volume, composing an injected ChangeSource) and remote (HTTP
// client, implementing all facets inline) both satisfy it.
export type SyncReplica = ChangeSource & ChangeApplier & BlobStore
```

- **Local adapter** (`localSyncReplica(storage, changes, { lazyContent, localActorId })`)
  wraps a `Storage`/`Volume`, a fixed `lazyContent` flag, and an **injected
  `ChangeSource`** (composition, not sniffing) — `journaledChangeSource(storage)`
  for owned backends, `nativeChangeSource(…)` for scan+diff — which it composes to
  serve `pathDeltas`/`pathScan` (applying the `/.state/**` exclusion on top). Its
  `applyPathChanges` does **not** call the public `setMeta`/`putBlob`/`putDirent`
  primitives — those treat each write as a fresh
  local mutation, bump the version generator, and stamp a LOCAL origin, discarding
  the incoming `version`/`source`. Instead, for each regular-file put it first
  materialises content out-of-band (eager: `putBlobByHash` the bytes fetched via
  `getBlobByHash`; lazy: skip), **then** calls the backend's transactional
  path-apply seam `PathMutationStore.applyJournaled` (below), which installs the
  tree metadata + `contentHash` ref, appends the journal row with the EXACT
  incoming `(version, origin source)`, records `localSource`, and advances
  `path_version` — all in one transaction. It resolves paths to local inos (reusing
  existing ones — in-place — or minting fresh). `pathDeltas` comes from the journal.
- **Remote adapter** is the HTTP client to `packages/core/src/fs.ts`
  (`remoteSyncReplica(client, { clientId })`): it implements `ChangeSource` +
  `ChangeApplier` + `BlobStore` **inline** over the `/fs` path endpoints rather
  than composing a local `ChangeSource`.
- **Topology selection lives in `synced()`**, whose `remote` prop is
  `Storage | ((ctx: { clientId }) => SyncReplica)`. A `Storage` is wrapped in a
  local adapter (two-folder P2P); a **factory** is the CLIENT↔SERVER case — the
  app injects `remoteSyncReplica(client, { clientId })` (from `@justfiles/core`,
  which `packages/fs` must **not** import, so it is injected). `synced()` passes
  the `clientId` it owns (`/.state/clientid`) into the factory, so the
  server-stamped origin matches pull's `excludeOrigin`. `push`/`pull`/`bootstrap`
  are topology-agnostic — they drive the abstract `SyncReplica` either way. The
  client↔server first sync runs a one-time `negotiate()` handshake (`GET /fs`);
  P2P shares the build and skips it.
- `synced.ts` pulls with `applyPathChanges(changes, getBlobByHash, { source:
  REMOTE_SOURCE })` so `volume.watch` and echo suppression keep working, while
  `PathChange.source` (origin client-id) still drives `excludeOrigin` filtering.

**The transactional path-apply seam.** Owned backends (SQLite + IDB) implement one
extra primitive so the local `SyncReplica` can apply remote changes atomically
without the generator clobbering the incoming version/origin:

```ts
// Below `Storage`, beside the journal — SQLite + IDB implement it. Applies
// remote-authored PathChanges in ONE mutation transaction each, and touches ONLY
// the tree + journal + version, NEVER blob bytes: it sets the inode's metadata +
// `contentHash` REFERENCE, appends the journal row with the incoming change
// VERBATIM (its exact `version` and origin `source`) plus `localSource`, and sets
// path_version[path] = max(path_version[path], change.version) (never bump).
// Content lives in the separate hash-addressed blob store; `applyPathChanges`
// owns materialising it, out-of-band.
export interface PathMutationStore {
	applyJournaled(
		changes: PathChange[],
		opts: { localSource?: string }
	): Promise<void>
}
```

`Storage` itself stays lean (no path methods); `PathMutationStore` is a separate,
small backend capability alongside the `JournalStore`.

**Content ownership is an explicit seam.** `applyJournaled` writes only the
`contentHash` reference; the bytes are handled by `applyPathChanges` *around* it,
because the blob store is **hash-addressed and separate from the tree**, so blob
writes are idempotent and need no shared transaction (a stored blob with no
referencing path is a harmless orphan the GC reclaims; a referenced hash with no
local blob is exactly the lazy-stub state that `readFile` hydrates):

- **Eager** (`lazyContent: false`): for each regular-file `put`, `applyPathChanges`
  first ensures the blob is present locally — `if (!await hasBlobByHash(hash)) await
  putBlobByHash(hash, await getBlobByHash(hash))` — **then** calls `applyJournaled`
  to install the metadata/ref. Content is durable before the path points at it.
- **Lazy** (`lazyContent: true`): skip the fetch; `applyJournaled` still installs
  the `contentHash` ref (stub). First `readFile` hydrates via `getBlobByHash` +
  `putBlobByHash` (see Lazy content).

`putBlobByHash(hash, data)` stores into **this replica's** hash-addressed blob
store: on the local adapter the backend content store (eager pull + lazy
hydration); on the remote adapter `PUT /fs/blob/:hash` (push). This makes
lazy/eager materialisation — and a future partial/block scheme — one explicit
place, not a hidden side effect of `applyJournaled`.

### Journaling / change detection (per-backend, behind `ChangeSource`)

Each replica reports "what changed since `cursor`" as ordered `PathChange`s. *How*
it detects that is backend-specific and hidden behind `ChangeSource`:

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

Every mutation goes through our API, so we append one **durable, append-only,
path-stamped journal row per change, in the same transaction** as the mutation.
The logic is shared; each backend supplies a tiny `JournalStore`.

```ts
// A journal row = a PathChange plus its monotonic position, PLUS the local apply
// source. `seq` IS this backend's SyncCursor.
//   - change.source = ORIGIN client-id (cross-replica; travels the wire).
//   - localSource   = who applied this write LOCALLY (undefined for a user's own
//     write; REMOTE_SOURCE when the sync layer applied it from a pull). Local-only.
interface JournalRow { seq: number; change: PathChange; localSource?: string }

interface JournalStore {
	append(changes: PathChange[], localSource?: string): Promise<void>  // within the mutation's txn
	readFrom(seq: number, limit: number): Promise<JournalRow[]>         // ordered by seq asc
	head(): Promise<number>                                             // latest seq (snapshot resume)
}

// Shared by SQLite + IDB. The journal is intrinsic to the store, so this reads
// `store.caps.journal` rather than taking it as a parameter (composed by
// `localSyncReplica`, which injects the resulting ChangeSource).
function journaledChangeSource(store: Storage): ChangeSource {
	const journal = store.caps?.journal
	if (!journal) throw new Error('backend exposes no path journal (caps.journal)')
	return {
		async pathDeltas(cursor, opts) {
			const limit = opts?.limit ?? PAGE
			const rows = await journal.readFrom(Number(cursor || '0'), limit)
			const kept = rows.filter(
				(r) =>
					(!opts?.excludeOrigin || r.change.source !== opts.excludeOrigin) &&
					(!opts?.excludeLocalSource || r.localSource !== opts.excludeLocalSource),
			)
			const changes = coalesceByPath(kept.map((r) => r.change))
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

The two primitives differ only in the storage layer:

```ts
// SQLite (DO): a table + PK index; append inside the fs mutation transaction.
//   CREATE TABLE journal (
//     seq INTEGER PRIMARY KEY AUTOINCREMENT,
//     path TEXT NOT NULL, kind TEXT NOT NULL,          -- 'put' | 'delete'
//     version INTEGER NOT NULL,                        -- internal; wire-encoded as decimal string
//     source TEXT,                                     -- ORIGIN client-id (wire)
//     local_source TEXT,                               -- LOCAL apply source
//     content_hash TEXT, meta_json TEXT);              -- meta/hash NULL for delete
//   -- the per-path scalar version generator, bumped in the SAME txn:
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
//   O(depth) index hops, not an O(N) scan.
```

#### Scalar `version` ownership + `origin`/`localSource` population

There are exactly **two write paths** into an owned backend; the journal fills its
three sync fields (`version`, `source`=origin, `local_source`) differently for
each. `MutationOptions.source` maps to **origin only** — never `localSource`:

- **Local mutation** — any write through the public `Storage` primitives: a user
  `Volume` write, *and* a generic ino-CRUD write via `apiStorage` (the endpoints
  we keep). The journal stamps `origin = MutationOptions.source ?? localActorId`
  (a browser/native backend uses its own client-id; the DO uses the pushing
  client-id from `SOURCE_HEADER`), `local_source = NULL`, and
  `version = COALESCE(path_version[p], 0) + 1` written to `path_version[p]` in the
  same txn.
- **Remote apply** — the transactional seam `PathMutationStore.applyJournaled`,
  used only by `SyncReplica.applyPathChanges` on pull. It journals the incoming
  change VERBATIM: `origin = change.source` (preserved, not re-stamped),
  `version = change.version` (not bumped), `local_source = REMOTE_SOURCE`, and sets
  `path_version[p] = max(path_version[p], change.version)` (fast-forward only —
  never lower it, even for a stale/losing change — so a later local edit yields
  `change.version + 1`, never restarts at 1). Excluded from push by
  `excludeLocalSource: REMOTE_SOURCE`.
- **Delete**: bump the version like any mutation and record it as the path's
  `tombstoneVersion` in `PathSyncState`; a later **recreate** at `p` starts from
  `max(path_version[p], tombstoneVersion) + 1`, so a resurrected path never sorts
  below its own tombstone.

`localActorId` is the backend's configured client-id. `PathSyncState` keeps the
*agreed* `baselineVersion` for conflict detection; `path_version` is the
*generator*. They are distinct: the generator is storage-internal and stamps
outgoing changes; the baseline is engine-internal (`/.state/sync`) and decides
winners on pull.

**Path stamping is O(depth), in-transaction.** When the mutation runs the tree is
consistent, so the backend resolves the path cheaply and stamps it into the row:

```ts
// putDirent(dir, name):    path = pathOf(dir) + '/' + name
// deleteDirent(dir, name): path = pathOf(dir) + '/' + name   (resolve BEFORE unlink)
// setMeta(ino) [content]:  path = pathOf(ino)
// pathOf walks parent dirents up to root — depth (~<20), not breadth. It needs a
// child→parent lookup (the `by-ino` index / stored parentIno above); without it
// pathOf would scan every dirent.
```

**Directory move / rename is journaled as an ordered subtree delete+put in ONE
txn.** `atomicMove(oldDir,oldName → newDir,newName)` (and any directory `putDirent`
that relocates a subtree) enumerates the affected subtree at mutation time and
appends, within the same mutation transaction:

1. `delete` rows for every old path, **child-before-parent** (leaves first, so a
   peer applying them never orphans a live child under a deleted dir), then
2. `put` rows for every new path, **parent-before-child** (dir exists before its
   entries).

Enumeration uses the same `by-ino`/`dirIno` indexes as `pathOf`; the subtree is
walked once. This is disk-bound (one journal row per descendant) — a first-class
`move` op that ships a single rename is a later optimisation (see Renames). A
single-file rename is the degenerate case: one `delete(old)` + one `put(new)`.

#### Native fs (spud-mac) — scan + diff

A real directory can be written by other processes, so a write-intercept journal
would miss changes. Keep a **persisted local index** and detect changes by
watching + scanning (the Syncthing model):

```ts
// path -> last-agreed identity. Persisted (sidecar SQLite/LevelDB), NOT an in-RAM tree.
interface NativeIndexRow { path: string; contentHash: string; mtimeNs: bigint; size: bigint; version: number /* v1-bounded int; compared numerically */ }

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

Cache the content hash by `(path, mtimeNs, size)` to avoid re-hashing unchanged
files. A periodic full scan is the backstop when the watcher drops events. Native
full participation needs content hashing + a path journal/delta source before it
can push (it has no journal today) — track as a follow-up.

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

`synced()` keeps two cursors under `/.state/sync`: a **push** cursor over the local
`ChangeSource`, and a **pull** cursor over the remote's.

**Echo suppression uses the two filters, mirroring today's `synced.ts`:**

- **push** reads local deltas with `pathDeltas(pushCursor, { excludeLocalSource:
  REMOTE_SOURCE })` — skip changes the sync layer itself applied from a pull, so we
  never bounce the server's own writes back. Surviving changes keep their
  `PathChange.source` (origin) as they go up.
- **pull** reads remote deltas with `pathDeltas(pullCursor, { excludeOrigin:
  clientId })` — skip changes this client authored (the server stamped our
  client-id as origin on push), then `applyPathChanges(…, { source: REMOTE_SOURCE })`
  which records `localSource = REMOTE_SOURCE` on the resulting local journal rows.

**Local-only paths.** With the journal below `Storage`, writes to `/.state` and
everything under it (sync cursors, client-id, `PathSyncState`) are themselves
journaled. The path model replaces today's `trusted.sync.local-only` xattr with a
single **hard path-prefix exclusion enforced in the local `SyncReplica`**:

- The exclusion matches **`/.state` itself AND `/.state/**`** — i.e.
  `p === '/.state' || p.startsWith('/.state/')`. A bare `startsWith('/.state/')`
  misses the directory node itself, which would leak an empty `/.state` dirent.
- `pathDeltas` / `pathScan` **drop any change** matching that predicate so it is
  never pushed; `applyPathChanges` **refuses to write** matching paths so a peer
  can never inject local state; and **post-scan reconcile ignores the same prefix**
  (never deletes local `/.state` because the remote snapshot lacks it). Being a
  hard path-level rule (not a per-inode flag), a second `volume(storage)` cannot
  bypass it.

`/.state/**` is the only local-only subtree the code has. A general user-facing
"exclude this path from sync" feature does not exist and is not in scope.

**Apply ordering & coalescing:** within a batch apply `put`s parent-before-child
and `delete`s child-before-parent; `coalesceByPath` collapses multiple ops on one
path to its final state. **Directory move** = ordered `delete(old subtree)` +
`put(new subtree)` (owned backends enumerate the subtree at rename time,
child-before-parent deletes then parent-before-child puts, in one txn). **Type
replacement** (file↔dir at a path) = recursive `delete` of the old subtree, ordered
before the `put` of the new node.

### Blob push protocol

Pull can `getBlobByHash` from the server. **Push cannot** — the server can't fetch
bytes from a browser by hash. Chosen: **`PUT /fs/blob/:hash` first, then
`POST /fs/path/changes`** referencing hashes (the alternative is inlining changed
bytes inside the changes POST). The server **must verify `sha256(bytes) === hash`**
before accepting a blob, and reject a `put` whose `contentHash` has no stored blob.
Small files may inline as an optimisation; large files upload first.

**Orphaned-blob GC:** a `PUT /fs/blob/:hash` whose follow-up `POST` never lands
leaves an unreferenced blob. Because blobs are content-addressed, a periodic sweep
drops any stored hash not referenced by a live path `contentHash` (mark-and-sweep
against the tree). Best-effort; no correctness dependency.

### `/fs` transport (path-based endpoints)

The remote `SyncReplica` is the HTTP client for these; the DO serves them over its
local `SyncReplica`. Request/response bodies reuse the canonical `PathChange` /
`SyncMeta` schema from **Wire schema** above (schema-first import) — no separate
wire types.

```ts
// packages/core/src/fs.ts — imports { PathChange } from the fs sync-wire contract.
// Deltas are one monotonic stream, so the page token IS the resume cursor.
const DeltaPage = z.object({
	changes: z.array(PathChange),
	to: z.string(),          // SyncCursor to persist AND next-page token (same seq)
	done: z.boolean()        // false => more pages remain
})
// Snapshot: pagination position and sync high-water are DISTINCT.
const ScanPage = z.object({
	changes: z.array(PathChange),
	next: z.string().optional(),  // opaque next-page token; absent when done
	syncCursor: z.string(),       // delta high-water frozen at scan start; resume here
	done: z.boolean()
})
// Handshake (forward compat): a client negotiates before syncing. `protocolVersion`
// = wire contract; `schemaVersion` = /.state/sync shape. A future breaking change
// bumps one of these; endpoints and paths stay stable.
const Handshake = z.object({
	rootIno: z.string(),
	protocolVersion: z.number().int(),
	schemaVersion: z.number().int()
})
type DeltaPage = z.infer<typeof DeltaPage>
type ScanPage = z.infer<typeof ScanPage>
```

Endpoints (each maps to one `SyncReplica` method):

```
# HANDSHAKE
GET  /fs                                         -> Handshake     # { rootIno, protocolVersion, schemaVersion }

# PULL  (client reads the server's ChangeSource)
GET  /fs/path/changes?cursor=&excludeOrigin=&limit=  -> DeltaPage   # pathDeltas
GET  /fs/path/snapshot?page=&limit=                  -> ScanPage    # pathScan (all puts)

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
  read). `excludeOrigin=<clientId>` drops the caller's own echoes.
- **Push:** `PUT /fs/blob/:hash` for new content (server verifies the hash), then
  `POST /fs/path/changes`; the handler applies to the DO's `Storage` and **rejects
  a `put` whose `contentHash` has no stored blob**. The client identifies itself
  **once per request** via the authenticated context — a **stable client-id in a
  header** (the client generates it once and persists it under `/.state`; formal
  server-side registration is unnecessary because the DO is already per-user) or
  the session. The handler **ignores any `source` in the body** and stamps that one
  client-id as `source` on every applied change, so a client cannot attribute
  changes to *other* devices. This is robustness within the user's own fleet, not a
  cross-tenant boundary: a forged id could only make the user's own fleet
  mis-suppress echoes. `excludeOrigin=<clientId>` on pull is trusted because the
  server itself stamped that id on the way in. See Topology, trust & authority.

These **replace the sync-specific ino endpoints.** `/updates` (`deltaUpdates`) and
`/ops` (`applyBatch`) served ino-sync only and are **deleted**. `/scan`
(`fullScan`) is **kept** — it also backs `volume.scan()` over the HTTP `apiStorage`
client (e.g. the CLI's remote volume), which is non-sync; only its sync-only
`syncCursor` return field is dropped.
**The generic ino CRUD endpoints stay** (`/inodes/:ino`, `/inodes/:ino/blob`,
`/inodes/:dirIno/entries/*`, `/inodes/:ino/xattrs/*`): they back the general
`apiStorage` Storage-over-HTTP client (CLI, worker, frieren `remote`, auth scripts)
for **non-sync** direct remote access, where ino identity within one authoritative
server is consistent. Path sync's hash-addressed `/fs/blob/:hash` coexists with the
ino-addressed `/inodes/:ino/blob`.

### Conflicts & versioning

**One uniform policy for every path. The sync engine has no notion of app files vs.
user files — it never inspects paths like `/applications/**`.**

- Per-path `version` (a Lamport-style counter; generated in the backend's
  `path_version` table, its last-agreed value tracked per path in
  `PathSyncState.baselineVersion`).
- Conflict (both sides changed since baseline) → a **deterministic winner**, not
  strictly "last write". The comparison key is a **total order over STABLE
  fields**: `(version, changeDigest)`, compared **numerically on `version` first**
  (parse the decimal wire string to an integer; never a lexicographic compare),
  then by `changeDigest` — a canonical SHA-256 over the change's durable file-state,
  and **nothing else**:
  - `kind` (`put` | `delete`), so an equal-version `put` vs `delete` is still
    ordered (deletes carry only `kind` + `path` + `version`; no meta);
  - for a `put`: `type, mode, mtimeNs, size, symlinkTarget, sorted xattrs,
    contentHash`.

  It deliberately **excludes `source`** and any echo-suppression metadata: push
  `source` is server-stamped, so the same logical change would otherwise digest
  differently before vs after upload and two replicas could disagree. Two changes
  with identical full state are simply **equal** (no winner needed). `mtimeNs`
  folds into the digest for puts (not a separate key term, so deletes — which have
  no `mtimeNs` — stay well-defined). This breaks the ties a `version`-only key
  leaves: two dirs/symlinks at the same path (no `contentHash`), or two files with
  equal `contentHash` but differing `mode`/xattrs. Both replicas compute the same
  digest and pick the same winner. (True concurrency detection via version vectors
  is a later upgrade; v1 needs only this deterministic total order.)
- **v1 conflict = LWW-by-version + log, everywhere. No conflict copies in v1.** The
  deterministic winner overwrites the loser and the overwrite is logged;
  `.sync-conflict` copies (preserve the loser, Syncthing-style, zero data loss) are
  the planned follow-up. This is uniform across steady-state **and** first
  bootstrap, so v1 never has to build the conflict-copy machinery.

**Ancestor delete vs. descendant edit — tree-level rule.** Per-path LWW alone can
leave an inconsistent tree: if the server recursively deletes `/a` while a client
raises `/a/b` to a higher version, a naive per-path resolution could keep `/a/b`
while dropping its parent `/a`. Policy: **a surviving descendant resurrects its
ancestor directories.**

- A recursive delete journals a `delete` row per descendant path
  (child-before-parent), so each path — including `/a/b` — gets its own per-path
  LWW decision against the concurrent `put`.
- After per-path LWW settles a batch, a single **tree-repair pass** ensures every
  *surviving* path's ancestors exist: any missing ancestor dir is (re)created with
  `version = max(childVersion, ancestorTombstoneVersion) + 1`, so the resurrected
  dir dominates the delete that removed it and is not re-deleted next cycle.
- **A resurrected dir gets DETERMINISTIC synthetic metadata**, so both replicas
  compute an identical node from the same converged surviving set:
  `type = Directory`, `mode = 0o755`, `xattrs = {}` (none),
  `mtimeNs = max(mtimeNs of its surviving direct children)`, `contentHash` = none.
  No implementation-specific defaults. (If the same path is later re-created by a
  real `put`, that put wins by version and replaces these synthetic values.)
- If instead the delete wins at the leaf (`/a/b` delete-version > put-version), no
  descendant survives and `/a` stays deleted. LWW decides each node; resurrection
  only repairs ancestors of nodes that already won.

### App-update / no-downgrade is a layer on top (out of scope)

The sync engine must **not** know that `/applications/**` are apps or that they
have a whole-bundle hash or a monotonic version. Deciding "this app has an update /
don't downgrade / reinstall a changed bundle" is **higher-level logic that observes
file changes** and reconciles against the app catalog — it does not live in, nor is
it called by, the sync loop.

Per [`docs/app-materialization.md`](./app-materialization.md): a materialiser/
app-update watcher subscribes to `volume.watch` for changes under
`/applications/<id>/*` (from *any* source — local edit or synced-down pull),
recomputes the app's whole-bundle `.apphash`, and if it differs from the catalog
reconciles **monotonically** (never downgrade) and quiesces the running app. So if
sync's uniform policy transiently lands a stale app bundle, this watcher corrects
it — the fix is *on top of* sync, using the file-change feed sync already emits.

### Path-keyed sync state + tombstones

Baselines **cannot** live in inode xattrs — they vanish on delete/recreate, which
is exactly when tombstone conflict detection matters. Store sync state **by path**
(in `/.state/sync`, itself local-only per the `/.state/**` exclusion):

```ts
// Versions are v1-bounded integers (see Version note); compared numerically.
type PathSyncState = {
	path: string
	baselineVersion: number      // last version BOTH replicas agreed on at this path
	lastSeenHash?: string        // last agreed content hash (undefined for dirs/symlinks)
	tombstoneVersion?: number    // set when the path was deleted; survives recreate
}
```

This is the engine's conflict-detection record, **distinct from the backend's
`path_version` generator**: `path_version` stamps the next outgoing version;
`baselineVersion` remembers the last agreed one so pull can tell *fast-forward*
(`remote.version > baseline`, `local` unchanged since baseline → accept) from
*conflict* (both moved past `baseline` → deterministic winner). On a delete, the
engine also records `tombstoneVersion` here so a resurrected path is versioned
above its own tombstone.

### Lazy content: desired hash vs local presence

For hash hydration the inode must **retain the desired remote `contentHash`** (the
content identity) while **blob presence is tracked separately**:

- The inode's `contentHash` is always set from the `PathChange` (what we *should*
  have).
- "Do we have it locally" = the **content store holds a blob for that hash**. So
  the local content store is **content-hash-addressed** (or keeps a hash→presence
  index). This dedupes and matches R2.
- Lazy `readFile(path)`: `stat` → if the content store lacks `stat.contentHash`,
  `getBlobByHash(stat.contentHash)` and store it; else read local.

### Scan / cursor semantics

`pathScan` returns TWO cursors (see `ChangeSource.pathScan`): a `next` page token
to walk the snapshot, and a `syncCursor` **high-water frozen at scan start over a
stable snapshot**. After applying every page, resume with `pathDeltas(syncCursor)`.
`put`s are **idempotent** (put path = meta+hash), so re-applying a write that landed
both in the scan and the post-scan delta is harmless. If a backend can't provide a
stable snapshot: capture `syncCursor` first, scan, then replay
deltas-from-`syncCursor` (idempotency covers overlap).

**Post-scan reconcile is by PATH, not ino:** after applying a full `pathScan`,
delete local paths **absent from the remote path snapshot** (the adoption guard
still gates whether reconcile runs — see First-bootstrap policy). Today's
`reconcileLocal` walks by ino; the path version deletes by path.

### First-bootstrap same-path policy

The adoption guard preserves a never-pushed profile's local work when it first
adopts a non-empty remote. Path identity makes the **same-path collision** explicit:
local (never-pushed) has `/x`, the remote snapshot also has `/x`.

**Policy (v1): keep local and bump its version so it wins the next push — no
conflict copy.** No app/user distinction. On a same-path collision where content
differs:

1. **Keep local** at `/x` (adoption's whole purpose: preserve never-pushed local
   work; local always wins).
2. **Bump the kept-local path's version** to `max(localVersion, remoteVersion) + 1`
   and set `PathSyncState.baselineVersion = remoteVersion`. Keeping local is not
   enough alone: if remote `/x` is version 2 and never-pushed local `/x` is version
   1, the next push would still lose. Bumping above the remote guarantees the
   subsequent push ships local up and wins deterministically.
3. **The remote loser is overwritten, not copied** — matching steady-state LWW.
   Preserving it as `x (conflict <ts>)` is the same deferred follow-up as
   steady-state conflict copies.

If content is identical, nothing changes except reconciling both versions to the
higher of the two. App bundles are not special-cased; if this leaves a stale local
app bundle, the app-update watcher (layer on top) reconciles monotonically.

### Renames

v1: **delete + put** (correct under path identity). Rename *detection* (match a
delete+put by identical `contentHash` to preserve local ino) is a later
optimisation; the blob is content-addressed so it isn't re-uploaded regardless.

### State layout & forward compatibility (no migration)

The product is **unreleased**, so there is **no backward-compat / auto-migration**:
any pre-existing local or test replicas are **wiped and recreated**.

- **State path is `/.state/sync`** — this design *is* v1 (no versioned path name).
  Local-only per the `/.state/**` exclusion.
- **Forward compat via an explicit version field, not the path name.** The sync
  state carries a `schemaVersion` (state shape); the `GET /fs` handshake returns
  `protocolVersion` (wire contract) alongside `schemaVersion`. A client reads the
  handshake before syncing; a future breaking change bumps the field and branches
  on it — the stable path `/.state/sync` and the endpoint routes never change:

  ```ts
  type SyncState = {
  	schemaVersion: number        // 1 for this design; future migrations branch on it
  	pushCursor?: SyncCursor      // over the local ChangeSource
  	pullCursor?: SyncCursor      // over the remote's ChangeSource
  	// PathSyncState records are stored per-path under the same /.state/sync tree
  }
  ```

- **No self-heal claims.** There are no old ino-forked replicas to converge. A
  fresh install does one `pathScan` bootstrap and proceeds.

### Topology, trust & authority model

v1 targets a **star topology**: many clients (browser/native) sync against **one
authoritative per-user server** (the frieren DO). Two layers have different
symmetry, and only one of them is server-shaped:

- **Data model — peer-symmetric, no authority.** No replica is privileged; the
  conflict winner is decided purely by `(version, changeDigest)`, identically on
  every replica, never by "which side is the server". `SyncReplica` is symmetric —
  local and remote both implement `pathDeltas`/`pathScan`/`applyPathChanges`.
  Convergence does not depend on a server.
- **Trust + transport — client↔server specific.** `source` is server-authoritative
  (a client identifies itself once via the authenticated request, never per-change
  in the body; the server stamps every applied change — see `/fs` transport). Blob
  transfer is asymmetric because a browser client can't serve bytes: pull reads
  blobs from the server, push uploads first (`PUT /fs/blob/:hash`). The `/fs`
  endpoints are a client→server REST shape (client active, server passive).

**Why `source` exists, and why it's star-specific.** Echo suppression has two
parts: **`localSource`** ("don't send back what I just received") is needed in
*every* topology; **`origin`/`source`** ("skip my own changes coming back") is
needed only because a client pulls a **shared server stream** that interleaves its
own and other devices' changes and must skip its own — which requires a trustworthy
per-author id, hence server-stamped. In point-to-point (one peer ↔ one peer),
`localSource` alone quiesces the loop and `origin` is at most an optimization.

**Fit for P2P — the core fits; the specialization doesn't, yet.**

- **Two folders on one computer works today.** Wire two **local** `SyncReplica`s
  over their own `Storage` backends and run an in-process pump both directions —
  exactly what the `twoPeers()` test harness does. No server, no HTTP: origins are
  self-stamped (`localActorId`), blobs are read directly, and `localSource`
  suppression quiesces the loop. *Local* peer-to-peer is already supported.
- **Networked, serverless, multi-writer P2P is a non-goal for v1** and would need:
  a **symmetric transport** (each peer serves its own `ChangeSource` + blobs, so
  push can pull bytes too); **self-stamped or signed origins** (no server to stamp
  identity); and **version vectors** for concurrency detection. The last matters
  most — a central server is a **serialization point** that funnels all writes into
  one order, keeping scalar-Lamport + LWW "good enough" (concurrent edits rare, the
  loser deterministically dropped). True P2P has no such point, so concurrent edits
  are common and scalar LWW would silently drop them; version vectors (the deferred
  conflict upgrade) become necessary.

**So v1 assumes the remote is the authoritative *identity-stamper and byte-server*,
not the authoritative *winner*** — winners are decided symmetrically by
`(version, changeDigest)` on every replica.

---

## Scope: where the changes land

Contained to `packages/fs` + the `packages/core` fs transport; **kernel/apps
untouched**.

1. `packages/fs` — add `SyncMeta` / `PathChange` types and the **`SyncReplica`**
   composition (`ChangeSource & ChangeApplier & BlobStore` role interfaces). Add a
   **local `SyncReplica`** (`localSyncReplica(storage, changes, opts)`) over
   `Volume`/`Storage` that composes an injected `ChangeSource`
   (`journaledChangeSource(storage)`), plus `applyPathChanges`, `pathScan`, and the
   path journal per "Journaling". `Storage` gains a minimal ordered **path-delta
   source** (the journal) and a **transactional path-apply seam**
   (`PathMutationStore`), not the wire protocol.
2. `packages/fs/synced.ts` — `push`/`pull`/`bootstrap` operate on `PathChange` via
   `SyncReplica`; state under `/.state/sync`, keyed by path (`PathSyncState` +
   tombstones); lazy `readFile` hydrates by `contentHash`.
3. `packages/core/src/fs.ts` — path-based endpoints per **`/fs` transport** above,
   served over the DO's own **local `SyncReplica`**; the remote adapter
   (`remoteSyncReplica(client, { clientId })` in `fs.client.ts`) is the HTTP client.
   **Delete** `/updates` + `/ops` (ino-sync only); **keep** `/scan` (also backs
   `volume.scan` over `apiStorage`) and the generic ino CRUD endpoints
   (`/inodes/:ino`, `/inodes/:ino/blob`, entries, xattrs) for non-sync access.
4. `storage.fs.ts` (native) — reference backend proving ino stays a real-OS concept.
   Full participation needs content hashing + a path journal/delta source (future).

Non-goals for v1: version vectors, rename detection, user-file conflict copies,
partial-block transfer (whole blobs, keyed by hash; R2 dedupes), and networked
serverless multi-writer P2P transport (see Topology, trust & authority — *local*
two-folder P2P already works via two local replicas).

---

## Plan

Built in three phases. Do **not** collapse them — lock the *shape* before
implementing, and have failing tests before writing code.

### Phase 0 — shape only (scaffold, fully wired, deliberately broken)

Write **only** the surface, no working bodies:

- All **types + Zod schemas** (`SyncMeta` / `PathChange` / `SyncPath` /
  `ContentHash` / `Version` / `DeltaPage` / `ScanPage` / `Handshake`, `SyncCursor`,
  `JournalRow` (with `localSource`), `PathSyncState`, `SyncState` (with
  `schemaVersion`)).
- All **interfaces** (`ChangeSource`, `ChangeApplier`, `BlobStore`, the composed
  `SyncReplica = ChangeSource & ChangeApplier & BlobStore`, `JournalStore`,
  `PathMutationStore`, the native index/watcher seams).
- Every concrete implementation body **throws `Error('not implemented')`**, marked
  `// TODO(path-sync): …`.
- **Hook it up completely** — wire the new `SyncReplica`/`ChangeSource` into
  `synced.ts`, the backends, and the `/fs` endpoints as if done.

This **breaks the running system, and that's expected.** The goal is to review the
*shape in situ* — how the new concepts are called and composed. Exit criteria: it
typechecks; every seam is wired; every unimplemented body is a `TODO` that throws;
design-review sign-off.

### Phase 1 — tests first (all red)

Maximum coverage before implementing:

- Write the three test layers (see Verification): **Layer 1** `SyncReplica`/seam
  units, **Layer 2** RED 1–16 + property test, **Layer 3** the ported `synced()`
  lifecycle suite.
- Cover the edge cases explicitly: rename, directory move (subtree delete+put
  across a page boundary), parent-dir delete + concurrent descendant edit (ancestor
  resurrection), path reuse/replacement, type replacement (file↔dir with recursive
  delete ordering), tombstone then recreate, dual-source echo suppression (push
  `excludeLocalSource` vs pull `excludeOrigin`), snapshot paging +
  `pathDeltas(syncCursor)` resume with no gaps, idempotent scan/delta overlap,
  adoption same-path (incl. higher-remote-version), `/.state` **and** `/.state/**`
  never crossing the wire, total equal-version tie-break for dirs/symlinks and
  equal-content-different-mode files, `contentHash` schema invariants, bigint/base64
  wire round-trip, lazy hydrate-by-hash.
- **Build test infra** — an in-memory backend implementing the **new** path
  `JournalStore` + `PathMutationStore`, `twoPeers()` / `adoptionPeers()` (real local
  `SyncReplica`s + a deterministic `syncBoth()`/`bootstrap()` that drives the real
  push/pull with the timer disabled), a numeric-ino backend, the `write(...,
  { version })` staging seam, and a seedable deterministic op generator.

Exit criteria: the suite is comprehensive and agreed; all red for the right reason
(`not implemented`), not from harness bugs.

### Phase 2 — implement until green

Bring the system online **one `TODO` at a time**, turning red tests green, until the
whole suite (RED 1–16 + property test) and the acceptance checklist pass. No new
surface area — only filling in the Phase 0 bodies against the Phase 1 tests. Exit
criteria: all tests green; acceptance checklist satisfied; the fork (RED 1) is
reproduced-then-fixed.

### Phase 3 — retire the ino-sync surface

Once path sync is green and shipped, delete the primitives that existed **only**
for ino-based sync. Usage was audited; each item below has no non-sync consumer.
**`Volume` has none to remove** — every method (`scan`, `watch`, `utimes`, xattrs, …)
has a general consumer.

Delete from `packages/fs/storage.ts` (`StorageCapabilities` + types), every backend
impl (`storage.idb.ts`, `storage.sqlite.ts`, `storage.mem.ts`), and the HTTP layer
(`fs.ts`, `fs.client.ts`):

- `deltaUpdates` + `UpdateQueryOptions` (`source`/`sourceMode`) — replaced by the
  path journal's `pathDeltas`.
- `applyBatch` — replaced by `applyPathChanges` + `PathMutationStore.applyJournaled`.
- `FsOp` (the ino-keyed wire op) **and** the backends' ino-op journal that feeds it
  (the ops table/store + `appendOps`/`withSource`/`filterOpsBySource`) — replaced by
  the path `JournalStore`.
- `FsCursorExpiredError` / `isFsCursorExpiredError` — tied to the `deltaUpdates`
  feed; re-introduce an equivalent only if the path journal's cursor can be pruned.
- HTTP endpoints `/updates` and `/ops` (+ their `apiStorage` client methods).
- `synced.ts`'s xattr-based sync state — the `trusted.sync.local-only` and
  `trusted.sync.baseline` machinery (replaced by the `/.state/**` path exclusion
  and `PathSyncState`).

Keep, but trim (dual-use — a real non-sync consumer remains):

- `fullScan` / `ScanEntry` / HTTP `/scan` — `volume.scan()` uses them as a tree-walk
  fast path, including over `apiStorage` (the CLI's remote volume; justbash scans
  `/`). Drop only the sync-only `syncCursor` return field.
- `subscribe` / `StorageChange` / `StorageChangeKind` — the `volume.watch` +
  cache-invalidation substrate, not sync.
- `MutationOptions.source` — still carries `origin`/`localSource` for path sync AND
  `source` for `volume.watch` echo filtering.
- Atomic/xattr/range caps (`atomicCreate`, `atomicMove`, `readRange`, `writeRange`,
  `truncate`, `*Xattr`) — general VFS primitives.

Exit criteria: the ino-sync symbols above are gone; `pnpm typecheck` + the suite
stay green with no remaining references.

### Sequencing

1. Ship the single-materialiser fix first (see
   [`docs/app-materialization.md`](./app-materialization.md)) — removes the
   common-case fork under today's ino sync.
2. This doc: path-based sync — makes forks structurally impossible and unblocks
   heterogeneous-backend sync. It is a prerequisite for that roadmap.

---

## Verification: red → green (TDD)

Tests in `packages/fs/synced.test.ts` (extend the mem-storage harness). Each RED
fails against today's ino-based sync; must pass (GREEN) after the change. Run
`pnpm vitest run packages/fs/synced.test.ts`.

**Three test layers, all exercising real code (no mock pump):**

1. **`SyncReplica` / seam units** — `applyPathChanges` / `pathDeltas` / `pathScan` /
   `*BlobByHash`, plus `JournalStore` + `PathMutationStore` behaviour (ordering,
   version fast-forward, coalescing, `/.state` exclusion, atomic apply). Fast, no
   timers.
2. **Path-sync semantics** — RED 1–16 + the property test below: convergence between
   two replicas.
3. **`synced()` orchestration/lifecycle** — the ported existing suite (cursor
   persistence under `/.state/sync`, adoption guard, lazy `readFile` hydration,
   echo-suppression wiring, retry/backoff, status transitions,
   `flush`/`pause`/`resume`/`destroy`); uses fake timers where needed.

`twoPeers()` builds two **real** local `SyncReplica`s over independent backends
(each mints its own inos; each implements the **new** path `JournalStore` +
`PathMutationStore`, not the old `deltaUpdates`). `syncBoth()` / `bootstrap()` drive
the **real** push/pull/bootstrap to quiescence with the timer disabled (a
`flush`-style step, as the current suite does), so the RED tests exercise the
engine, not the harness. Staging sugar like `write(path, bytes, { version })` is a
**test-only seam** that pins `path_version[path]`; resolution/apply still run the
real tie-break + LWW.

### RED 1 — the fork heals (generic path identity, no app semantics)

Seed **explicit path versions** via the harness staging seam (see above);
app-version/no-downgrade lives in `docs/app-materialization.md`.

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

### RED 2 — heterogeneous ino spaces sync

```ts
test('syncs between a numeric-ino and a uuid-ino backend, both behind SyncReplica', async () => {
	// Two backends implementing SyncReplica; inos are backend-local and disjoint.
	const native = memStorage({ mintIno: numericIno })  // "2","3",… like OS inodes
	const uuid   = memStorage({ mintIno: uuidIno })
	const { syncBoth } = wire(native, uuid)
	await native.writeFile('/data/note.txt', bytes('hello'))
	await syncBoth()
	expect(text(await uuid.readFile('/data/note.txt'))).toBe('hello')  // arrives by PATH
})
```

### RED 3 — in-place update keeps the local ino

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

### RED 4 — delete propagates by path, across a divergent tree

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

### RED 6 — lazy content hydrates by hash, stub retains desired hash

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
No conflict copy is asserted — v1 loses the remote loser everywhere. Preserving it
as `todo.md (conflict)` is the deferred follow-up. App bundles are not tested here;
"stale app bundle gets reconciled to newest" is a **materialiser** test.

### RED 8 — snapshot pages, then `pathDeltas(syncCursor)` resumes with no gaps

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

### RED 9 — adoption where remote version is higher: local kept, then pushes and wins

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

### RED 10 — `/.state` and `/.state/**` never cross the wire

```ts
test('local state at /.state and under it is never pushed or applied', async () => {
	const { client, server, syncBoth, pushedChanges } = twoPeers()
	await client.writeFile('/notes/a', bytes('hi')); await syncBoth()
	// clientid + sync cursors were written to /.state during the cycle:
	const pushed = pushedChanges().map((c) => c.path)
	expect(pushed.some((p) => p === '/.state' || p.startsWith('/.state/'))).toBe(false)
	expect(await server.exists('/.state')).toBe(false)       // not even the dir node leaked
})
```

### RED 11 — directory rename with children across a page boundary

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
test('concurrent equal-version, equal-mtime writes pick the SAME winner on both sides', async () => {
	const { client, server, syncBoth } = twoPeers()
	// Equal version AND equal mtime: the tie-break must be TOTAL and STABLE — a
	// canonical digest of the change's DURABLE state (kind + meta + contentHash),
	// explicitly EXCLUDING the server-stamped `source` — so it resolves even where
	// a version-only key tied, and both replicas agree regardless of upload order:
	//  - two dirs at the same path (no contentHash),
	//  - two files with EQUAL content but DIFFERENT mode.
	await server.write('/f', bytes('X'), { version: 5, mtimeNs: '100', mode: 0o644 })
	await client.write('/f', bytes('X'), { version: 5, mtimeNs: '100', mode: 0o600 })
	await server.mkdir('/d', { version: 5, mtimeNs: '100', mode: 0o755 })
	await client.mkdir('/d', { version: 5, mtimeNs: '100', mode: 0o700 })
	await syncBoth()
	expect((await client.stat('/f')).mode).toBe((await server.stat('/f')).mode) // same file winner
	expect((await client.stat('/d')).mode).toBe((await server.stat('/d')).mode) // same dir winner
})
```

### RED 14 — ancestor delete vs concurrent descendant edit

```ts
test('a winning descendant edit resurrects its deleted ancestor directory', async () => {
	const { client, server, syncBoth } = twoPeers()
	await server.writeFile('/a/b', bytes('v1')); await syncBoth()      // converge
	// Concurrent: server recursively deletes /a; client raises /a/b to a higher version.
	await server.rm('/a', { recursive: true })
	await client.writeFile('/a/b', bytes('v2'))                        // higher per-path version
	await syncBoth()
	// /a/b wins per-path, so its ancestor /a is resurrected on both replicas.
	expect((await client.stat('/a')).type).toBe(FileType.Directory)
	expect(text(await client.readFile('/a/b'))).toBe('v2')
	expect((await server.stat('/a')).type).toBe(FileType.Directory)   // no orphan under a deleted dir
	// resurrected dir has DETERMINISTIC synthetic metadata, identical on both sides
	expect((await client.stat('/a')).mode).toBe(0o755)
	expect((await client.stat('/a')).mode).toBe((await server.stat('/a')).mode)
})
```

### RED 15 — schema invariants: hash, version encoding, type, root

```ts
test('PathChange schema enforces hash/version/type/root invariants', () => {
	const dirMeta = { type: FileType.Directory, mode: 0o755, mtimeNs: '0', size: '0' }
	// regular-file put with no contentHash -> reject
	expect(() => PathChange.parse({
		kind: 'put', path: '/f', version: '1',
		meta: { type: FileType.Regular, mode: 0o644, mtimeNs: '0', size: '0' },
	})).toThrow()
	// dir/symlink put carrying a contentHash -> reject
	expect(() => PathChange.parse({
		kind: 'put', path: '/d', version: '1', contentHash: 'a'.repeat(64), meta: dirMeta,
	})).toThrow()
	// version must be a decimal STRING, not a number
	expect(() => PathChange.parse({ kind: 'put', path: '/d', version: 1, meta: dirMeta })).toThrow()
	// type must be a FileType enum value, not an arbitrary number
	expect(() => PathChange.parse({
		kind: 'put', path: '/d', version: '1', meta: { ...dirMeta, type: 99 },
	})).toThrow()
	// root is never a change subject
	expect(() => PathChange.parse({ kind: 'delete', path: '/', version: '1' })).toThrow()
})
```

### RED 16 — the conflict digest is source-independent

```ts
test('the same durable change wins identically regardless of stamped source', async () => {
	// Two identical file states at the same path+version but different origin source
	// (e.g. pre-upload undefined vs server-stamped clientId) must digest the SAME,
	// so both replicas pick the same winner and converge (no source in the digest).
	const { client, server, syncBoth } = twoPeers()
	await server.write('/f', bytes('SAME'), { version: 7, mtimeNs: '5', source: undefined })
	await client.write('/f', bytes('SAME'), { version: 7, mtimeNs: '5', source: 'clientA' })
	await syncBoth()
	expect(text(await client.readFile('/f'))).toBe('SAME')
	expect(text(await server.readFile('/f'))).toBe('SAME') // identical state => equal, converged
})
```

### GREEN — guardrails to keep

- The **Layer 3** `synced()` lifecycle suite (push/pull/bootstrap/adoption/lazy/
  status/flush/pause/resume) is **ported to the path API and still passes** — it
  drives the real `synced()`, as today.
- **Property test** (deterministic-seeded): random `writeFile/rm/rename/mkdir` on
  two peers, sync, assert **both trees byte-identical by path** and **zero orphaned
  inodes**.

---

## Acceptance checklist

- Path changes are **journaled or translated with historical path/tombstone
  correctness** — not resolved against final tree state.
- Push **uploads blobs by hash; the server verifies** them; rejects a `put` whose
  `contentHash` has no stored blob.
- **The sync engine is uniform and app-agnostic** — one conflict policy for every
  path; never inspects `/applications/**`. App update / no-downgrade is a layer on
  top (`docs/app-materialization.md`).
- **Baselines/tombstones stored by path** (`PathSyncState`), not inode xattrs; the
  scalar `version` **generator lives in the backend `path_version` table**, bumped
  in the same txn as the journal row.
- **`applyPathChanges` carries a local-apply `source`** (`REMOTE_SOURCE`), distinct
  from `PathChange.source` (origin). Push `source` is server-authoritative — stamped
  from a stable client-id (header/session), never read from the request body.
- **Two source concepts split** — wire `origin` (`PathChange.source`) vs local
  `localSource`; `pathDeltas` exposes `excludeOrigin` (pull) and
  `excludeLocalSource` (push). `MutationOptions.source` maps to origin only.
- **Remote apply goes through the transactional seam** `PathMutationStore.
  applyJournaled` — tree mutation + journal row (incoming version/origin verbatim)
  + `localSource` + `path_version` fast-forward in ONE txn; metadata + `contentHash`
  ref only, blobs materialised out-of-band by `applyPathChanges`.
- **Journal lives at/below `Storage`** (not a bypassable `Volume` wrapper).
  **Directory move = ordered subtree delete+put in one txn**, needing a child→parent
  index for `pathOf`.
- **Ancestor delete vs descendant edit** — per-path LWW then resurrect ancestors of
  surviving paths with **deterministic synthetic dir metadata** (`mode 0o755`, empty
  xattrs, `mtimeNs = max(surviving children)`).
- **Local-only state excluded by path** — one hard rule matching `/.state` **and**
  `/.state/**`; never pushed/applied, reconcile ignores it.
- **First-bootstrap same-path policy** — keep local **and bump kept-local version
  above the remote** so the next push wins; the loser is overwritten, not copied.
- **Conflict = LWW-by-version + log everywhere in v1; no conflict copies** (steady
  state or bootstrap). Tie-break is **total and source-independent**:
  `(version, changeDigest)` over durable state.
- **Lazy hydration explicit** — stubs retain the remote content hash and skip the
  fetch; local blob presence tracked separately (`hasBlobByHash`).
- **`pathScan` returns split cursors** — a `next` page token AND a `syncCursor`
  high-water frozen at scan start; paged bootstrap resumes `pathDeltas(syncCursor)`
  with no gaps (idempotent apply); post-scan reconcile deletes by **path**, not ino.
- **State at `/.state/sync` with `schemaVersion`**; `GET /fs` handshake returns
  `{ rootIno, protocolVersion, schemaVersion }`; no auto-migration.
- **Generic ino CRUD endpoints kept for `apiStorage`**; sync-only `/updates` and
  `/ops` removed. `/scan` (`fullScan`) kept for `volume.scan`, minus its
  `syncCursor` field.
- **Ino-sync surface retired (Phase 3)** — `deltaUpdates`, `applyBatch`, `FsOp` +
  its ino-op journal, `UpdateQueryOptions`, `FsCursorExpiredError`, and the
  `trusted.sync.*` xattr state are deleted; no non-sync consumer remains.
- **Wire schema locked** — `SyncPath`/`ContentHash`/`Version` (decimal-string wire,
  v1-bounded integer when persisted, compared numerically), `SyncMeta.type` a
  `FileType` enum, `ctimeNs` omitted (synthesised on apply), `xattrs` a complete
  snapshot, regular-file puts require a hash / dirs+symlinks forbid it, `put('/')`
  and `delete('/')` rejected.
- **RED 1–16 pass** (RED 5 in the materialiser doc), plus the deterministic property
  test.
