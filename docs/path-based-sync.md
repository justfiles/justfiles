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
> **Round 5 (issue #143):** the product is unreleased, so **no backward compat /
> no auto-migration** — old replicas are wiped, state lives at `/.state/sync` (this
> IS v1), and forward-compat is handled by an explicit `schemaVersion` in the sync
> state, not a versioned path name. Also: split the journal's two `source`
> concepts (`origin` on the wire vs local `localSource`) with explicit
> `excludeOrigin` / `excludeLocalSource` filters; add an ancestor-delete-vs-
> descendant-edit tree policy (surviving puts resurrect ancestors); make the
> equal-version tie-break **total** (canonical hash of the whole change); require
> `contentHash` for regular-file puts and forbid it for dirs/symlinks (schema);
> make lazy hydration explicit on the local replica; exclude `/.state` **and**
> `/.state/**`; reject `delete('/')`; keep the generic ino CRUD endpoints for
> `apiStorage` (remove only the sync-specific `/updates`,`/scan`,`/ops`).
> **Round 6 (issue #143 re-review):** add the transactional path-apply seam
> (`PathMutationStore.applyJournaled`) so remote apply writes the incoming
> version/origin verbatim in one txn (public primitives can't); make the conflict
> digest **source-independent** and total (`(version, changeDigest)` over durable
> state, excluding server-stamped `source`, deletes well-defined); encode
> `version` as a decimal string (not `z.number()`); add the `GET /fs` handshake
> (`protocolVersion`/`schemaVersion`); define journal `origin`/`localSource`
> sourcing for generic ino-CRUD writes; and tighten the schema (`FileType` enum,
> reject `put('/')`/`delete('/')`).
> **Round 7 (issue #143 re-review):** make blob content an **explicit seam** —
> `applyJournaled` writes metadata + `contentHash` ref only, `applyPathChanges`
> owns byte materialisation (eager `putBlobByHash` before apply, lazy on read);
> state one version representation — decimal string on the wire, v1-bounded integer
> when persisted, **compared numerically not lexicographically**; and give a
> resurrected ancestor directory **deterministic synthetic metadata**.

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

// Per-path Lamport version. Encoded as a DECIMAL STRING on the wire (like
// mtimeNs/size), NOT z.number() (re-review): versions are long-lived protocol
// data, and a string can widen to bigint later without a wire change or a 2^53
// ceiling.
//
// v1 REPRESENTATION (re-review): the wire is the only place version is a string.
// PERSISTED/INTERNAL versions — `path_version`, `PathSyncState.baselineVersion` /
// `tombstoneVersion`, `NativeIndexRow.version` — are bounded to SQLite/JS-safe
// integers for v1 (encode->string only at the wire boundary; parse->integer on
// the way in). Widening to bigint is a future migration. COMPARISONS ARE ALWAYS
// NUMERIC (parse then compare), never lexicographic — else "10" would sort below
// "9".
export const Version = z.string().regex(/^(0|[1-9][0-9]*)$/)

export const SyncMeta = z.object({
	type: z.nativeEnum(FileType),           // Regular | Directory | Symlink — enum, not any number
	mode: z.number().int(),
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

// A change to the tree, addressed by path. `version` drives generic LWW (see
// Conflicts). `source` = origin client-id, so a replica filters its own echoes on
// pull (same role as today's `MutationOptions.source` / `REMOTE_SOURCE`). On the
// PUSH endpoint `source` is NOT read from the body — the server stamps it from
// the authenticated request context (see /fs transport, #142.8).
//
// `contentHash` invariants are SCHEMA-ENFORCED (#143.4): a regular-file put MUST
// carry a hash (empty files included — the SHA-256 of empty bytes,
// e3b0c442…b855) so every regular file is hydratable; dirs/symlinks MUST NOT
// carry one. The root `/` is never a change subject (re-review): `put('/')` and
// `delete('/')` are both rejected here.
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
	// remain. Deletes carry the removed path; a rename is delete(old) + put(new).
	//
	// TWO independent echo filters, because a journal row has TWO source concepts
	// (#143.1): `excludeOrigin` drops changes whose ORIGIN client-id (the
	// cross-replica `PathChange.source`) matches — used by REMOTE pull to skip this
	// client's own authored changes; `excludeLocalSource` drops rows whose LOCAL
	// apply source matches (e.g. `REMOTE_SOURCE`) — used by LOCAL push to skip
	// changes the sync layer itself applied from a pull. They are not
	// interchangeable and both are needed.
	pathDeltas(
		cursor: SyncCursor,
		opts?: { excludeOrigin?: string; excludeLocalSource?: string; limit?: number }
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
	// Apply remote changes locally. `opts.source` tags the LOCAL write (e.g.
	// REMOTE_SOURCE) — it becomes the journal row's `localSource` for push
	// suppression and drives volume.watch. It is distinct from PathChange.source,
	// the ORIGIN client-id used for pull-side `excludeOrigin` filtering (#143.1).
	//
	// Content handling is explicit (#143.5): a regular-file put either
	//   - EAGER: `getBlobByHash(contentHash)` now and store it, or
	//   - LAZY:  write a stub that RETAINS `contentHash` and skip the fetch;
	//            readFile hydrates on first access (see Lazy content).
	// The mode is fixed per local replica at construction (`lazyContent`), not per
	// call, so `getBlobByHash` is only invoked in eager mode.
	applyPathChanges(
		changes: PathChange[],
		getBlobByHash: (h: string) => Promise<Uint8Array>,
		opts?: { source?: string }
	): Promise<void>
	// Content, addressed by hash (R2 already is).
	getBlobByHash(hash: string): Promise<Uint8Array>
	hasBlobByHash(hash: string): Promise<boolean>  // local presence check (see Lazy content)
	// Store a blob in THIS replica's hash-addressed blob store. Local adapter: writes
	// the backend content store (eager pull + lazy hydration). Remote adapter: PUT
	// /fs/blob/:hash (push). Content is materialised HERE, never inside applyJournaled.
	putBlobByHash(hash: string, data: Uint8Array): Promise<void>
}
```

- **Local adapter** wraps a `Storage`/`Volume`, constructed with a fixed
  `lazyContent` flag (#143.5). Crucially, its `applyPathChanges` does **not** call
  the public `setMeta`/`putBlob`/`putDirent` primitives — those would treat each
  write as a fresh local mutation, bump the version generator, and stamp a LOCAL
  origin, discarding the incoming `version`/`source`. Instead, for each
  regular-file put it first materialises content out-of-band (eager: `putBlobByHash`
  the bytes fetched via `getBlobByHash`; lazy: skip), **then** calls the backend's
  **transactional path-apply seam** `PathMutationStore.applyJournaled` (below),
  which installs the tree metadata + `contentHash` ref, appends the journal row
  with the EXACT incoming `(version, origin source)`, records `localSource`, and
  advances `path_version` — all in one transaction. It resolves paths to local inos
  (reusing existing ones — in-place — or minting fresh). `pathDeltas` comes from the
  path journal below.
- **Remote adapter** is the HTTP client to `packages/core/src/fs.ts` new endpoints.
- `synced.ts` pulls with `applyPathChanges(changes, getBlobByHash, { source:
  REMOTE_SOURCE })` so `volume.watch` and echo suppression keep working, while
  `PathChange.source` (origin client-id) still drives `excludeOrigin` filtering.

**The transactional path-apply seam (re-review #1).** Owned backends (SQLite + IDB)
implement one extra primitive so the local `SyncReplica` can apply remote changes
atomically without the generator clobbering the incoming version/origin:

```ts
// Below `Storage`, beside the journal — SQLite + IDB implement it. Applies
// remote-authored PathChanges in ONE mutation transaction each, and touches ONLY
// the tree + journal + version, NEVER blob bytes (re-review #1): it sets the
// inode's metadata + `contentHash` REFERENCE, appends the journal row with the
// incoming change VERBATIM (its exact `version` and origin `source`) plus
// `localSource`, and sets path_version[path] = max(path_version[path],
// change.version) (never bump). Content lives in the separate hash-addressed blob
// store; `applyPathChanges` owns materialising it (below), out-of-band.
export interface PathMutationStore {
	applyJournaled(
		changes: PathChange[],
		opts: { localSource?: string }
	): Promise<void>
}
```

This is the seam Phase 0 must scaffold; without it `applyPathChanges` has no way
to write “this exact version, authored by that origin, applied-by-us” atomically.
`Storage` itself stays lean (no path methods); `PathMutationStore` is a separate,
small backend capability alongside the `JournalStore`.

**Content ownership is an explicit seam (re-review #1).** `applyJournaled` writes
only the `contentHash` reference; the bytes are handled by `applyPathChanges`
*around* it, because the blob store is **hash-addressed and separate from the
tree**, so blob writes are idempotent and need no shared transaction (a stored
blob with no referencing path is a harmless orphan the GC reclaims; a referenced
hash with no local blob is exactly the lazy-stub state that `readFile` hydrates):

- **Eager** (`lazyContent: false`): for each regular-file `put`, `applyPathChanges`
  first ensures the blob is present locally — `if (!await hasBlobByHash(hash)) await
  putBlobByHash(hash, await getBlobByHash(hash))` — **then** calls `applyJournaled`
  to install the metadata/ref. So content is durable before the path points at it.
- **Lazy** (`lazyContent: true`): skip the fetch entirely; `applyJournaled` still
  installs the `contentHash` ref (stub). First `readFile` hydrates via
  `getBlobByHash` + `putBlobByHash` (see Lazy content).

Here `putBlobByHash(hash, data)` stores into **this replica's** hash-addressed blob
store: on the local adapter that is the backend content store (used by eager pull
and lazy hydration); on the remote adapter it is `PUT /fs/blob/:hash` (used by
push). This makes lazy/eager materialisation — and a future partial/block content
scheme — a single, explicit place, not a hidden side effect of `applyJournaled`.

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
// A journal row = a PathChange plus its monotonic position, PLUS the local apply
// source. `seq` IS this backend's SyncCursor.
//   - change.source = ORIGIN client-id (cross-replica; travels the wire).
//   - localSource   = who applied this write LOCALLY (undefined for a user's own
//     write; REMOTE_SOURCE when the sync layer applied it from a pull). Local-only;
//     never leaves this replica. (#143.1)
interface JournalRow { seq: number; change: PathChange; localSource?: string }

// The only primitive a backend implements for the shared journal logic. `append`
// records the local apply source alongside each change.
interface JournalStore {
	append(changes: PathChange[], localSource?: string): Promise<void>  // within the mutation's txn
	readFrom(seq: number, limit: number): Promise<JournalRow[]>         // ordered by seq asc
	head(): Promise<number>                                             // latest seq (snapshot resume)
}

// Shared by SQLite + IDB — this is the whole ChangeSource for owned backends.
function journaledChangeSource(store: Storage, journal: JournalStore): ChangeSource {
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

The two primitives are trivially different:

```ts
// SQLite (DO): a table + PK index; append inside the fs mutation transaction.
//   CREATE TABLE journal (
//     seq INTEGER PRIMARY KEY AUTOINCREMENT,
//     path TEXT NOT NULL, kind TEXT NOT NULL,          -- 'put' | 'delete'
//     version INTEGER NOT NULL,                     -- internal; wire-encoded as decimal string
//     source TEXT,                                     -- ORIGIN client-id (wire)
//     local_source TEXT,                               -- LOCAL apply source (#143.1)
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

**Scalar `version` ownership + `origin`/`localSource` population (#142.4, re-review).**
There are exactly **two write paths** into an owned backend, and the journal fills
its three sync fields (`version`, `source`=origin, `local_source`) differently for
each. `MutationOptions.source` maps to **origin only** — it never doubles as
`localSource` (the bug the re-review warns against):

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

`localActorId` is the backend's configured client-id. `PathSyncState` (below)
keeps the *agreed* `baselineVersion` for conflict detection; `path_version` is the
*generator*. They are distinct: the generator is storage-internal and stamps
outgoing changes; the baseline is engine-internal (`/.state/sync`) and decides
winners on pull.

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

`synced()` keeps two cursors under `/.state/sync`: a **push** cursor over the
local `ChangeSource`, and a **pull** cursor over the remote's (the path-based
successors of today's `localCursor`/`remoteCursor`).

**Echo suppression uses the two filters (#143.1), mirroring today's `synced.ts`:**

- **push** reads local deltas with `pathDeltas(pushCursor, { excludeLocalSource:
  REMOTE_SOURCE })` — skip changes the sync layer itself applied from a pull, so
  we never bounce the server's own writes back. Surviving changes keep their
  `PathChange.source` (origin) as they go up.
- **pull** reads remote deltas with `pathDeltas(pullCursor, { excludeOrigin:
  clientId })` — skip changes this client authored (the server stamped our
  client-id as origin on push), then `applyPathChanges(…, { source: REMOTE_SOURCE })`
  which records `localSource = REMOTE_SOURCE` on the resulting local journal rows.

**Local-only paths (#142.6).** With the journal below `Storage`, writes to
`/.state` and everything under it (sync cursors, client-id, `PathSyncState`) are
themselves journaled. The path model replaces today's `trusted.sync.local-only`
xattr with a single **hard path-prefix exclusion enforced in the local
`SyncReplica`**:

- The exclusion matches **`/.state` itself AND `/.state/**`** — i.e.
  `p === '/.state' || p.startsWith('/.state/')`. A bare `startsWith('/.state/')`
  misses the directory node itself, which would leak an empty `/.state` dirent
  (#143 cleanup).
- `pathDeltas` / `pathScan` **drop any change** matching that predicate so it is
  never pushed; `applyPathChanges` **refuses to write** matching paths so a peer
  can never inject local state; and **post-scan reconcile ignores the same prefix**
  (never deletes local `/.state` because the remote snapshot lacks it). This is a
  hard, path-level rule — not a per-inode flag — so a second `volume(storage)`
  cannot bypass it.

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
// Handshake (re-review forward-compat): the existing `GET /` (returns rootIno) is
// extended so a client can negotiate before syncing. `protocolVersion` = wire
// contract; `schemaVersion` = /.state/sync shape. A future breaking change bumps
// one of these; endpoints and paths stay stable.
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
  read — see Lazy content). `excludeOrigin=<clientId>` drops the caller's own echoes.
- **Push:** `PUT /fs/blob/:hash` for new content (server verifies the hash), then
  `POST /fs/path/changes`; the handler applies to the DO's `Storage` and **rejects
  a `put` whose `contentHash` has no stored blob**. The handler **takes the origin
  client-id from the authenticated request context (session/header), not from
  per-change `PathChange.source` in the body** (#142.8), and stamps it on every
  applied change. This is robustness/defense-in-depth, not a cross-tenant security
  boundary: each DO is per-authenticated-user, so all callers are that user's own
  devices — a forged `source` could only make the user's own fleet mis-suppress
  echoes. The device id still originates client-side; the server just refuses to
  trust it per-change. `excludeOrigin=<clientId>` on pull is trusted because the
  server itself stamped that id on the way in.

These **replace and remove only the sync-specific ino endpoints** `/updates`,
`/scan`, `/ops` — deleted, not kept for debug (they only served ino-based sync,
which no longer exists). **The generic ino CRUD endpoints stay** (`/inodes/:ino`,
`/inodes/:ino/blob`, `/inodes/:dirIno/entries/*`, `/inodes/:ino/xattrs/*`): they
back the general `apiStorage` Storage-over-HTTP client (used by the CLI, worker,
frieren `remote`, auth scripts) for **non-sync** direct remote access, where ino
identity within one authoritative server is consistent (#143 cleanup). Path sync's
hash-addressed `/fs/blob/:hash` coexists with the ino-addressed `/inodes/:ino/blob`.

### Conflicts & versioning

**One uniform policy for every path. The sync engine has no notion of app files
vs. user files — it never inspects paths like `/applications/**`.**

- Per-path `version` (a Lamport-style counter; generated in the backend's
  `path_version` table — see Scalar `version` ownership above — and its last-agreed
  value tracked per path in `PathSyncState.baselineVersion`).
- Conflict (both sides changed since baseline) → a **deterministic winner**, not
  strictly "last write". The comparison key is a **total order over STABLE fields**
  (#143.3, re-review): `(version, changeDigest)`, compared **numerically on
  `version` first** (parse the decimal wire string to an integer; never a
  lexicographic string compare), then by `changeDigest` — a canonical SHA-256 over
  the change's durable file-state, and **nothing else**:
  - `kind` (`put` | `delete`), so an equal-version `put` vs `delete` is still
    ordered (deletes carry only `kind` + `path` + `version`; no meta);
  - for a `put`: `type, mode, mtimeNs, size, symlinkTarget, sorted xattrs,
    contentHash`.

  It deliberately **excludes `source`** and any echo-suppression metadata: push
  `source` is server-stamped, so the same logical change would otherwise digest
  differently before vs after upload and two replicas could disagree. Two changes
  with identical full state are simply **equal** (no winner needed) rather than
  force-discriminated. `mtimeNs` folds into the digest for puts (it is not a
  separate key term, so deletes — which have no `mtimeNs` — stay well-defined).
  This breaks the residual ties the old key left: two dirs/symlinks at the same
  path (no `contentHash`), or two files with equal `contentHash` but differing
  `mode`/xattrs. Both replicas compute the same digest and pick the same winner.
  (True concurrency detection via version vectors is a later upgrade; v1 only
  needs this deterministic total order.)
- **v1 conflict = LWW-by-version + log, everywhere. No conflict copies in v1.**
  The deterministic winner overwrites the loser and the overwrite is logged;
  `.sync-conflict` copies (preserve the loser, Syncthing-style, zero data loss)
  are the planned follow-up. This is uniform across steady-state **and** first
  bootstrap — bootstrap does not special-case a copy (see First-bootstrap policy),
  so v1 never has to build the conflict-copy machinery.

**Ancestor delete vs. descendant edit — tree-level rule (#143.2).** Per-path LWW
alone can leave an inconsistent tree: if the server recursively deletes `/a` while
a client raises `/a/b` to a higher version, a naive per-path resolution could keep
`/a/b` while dropping its parent `/a`. Policy: **a surviving descendant resurrects
its ancestor directories.**

- A recursive delete journals a `delete` row per descendant path (child-before-
  parent), so each path — including `/a/b` — gets its own per-path LWW decision
  against the concurrent `put`.
- After per-path LWW settles a batch, a single **tree-repair pass** ensures every
  *surviving* path's ancestors exist: any missing ancestor dir is (re)created with
  `version = max(childVersion, ancestorTombstoneVersion) + 1`, so the resurrected
  dir dominates the delete that removed it and is not re-deleted next cycle.
- **A resurrected dir gets DETERMINISTIC synthetic metadata** (re-review), so both
  replicas compute an identical node from the same converged surviving set:
  `type = Directory`, `mode = 0o755`, `xattrs = {}` (none),
  `mtimeNs = max(mtimeNs of its surviving direct children)`, `contentHash` = none.
  No implementation-specific defaults. (If the same path is later re-created by a
  real `put`, that put wins by version and replaces these synthetic values.)
- If instead the delete wins at the leaf (`/a/b` delete-version > put-version), no
  descendant survives and `/a` stays deleted. So the rule composes with per-path
  LWW rather than overriding it: LWW decides each node; resurrection only repairs
  ancestors of nodes that already won.

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
(in `/.state/sync`, itself local-only per the `/.state/**` exclusion above):

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

### State layout & forward compatibility (no migration — #143)

The product is **unreleased**, so there is **no backward-compat / auto-migration**
story: any pre-existing local or test replicas are simply **wiped and recreated**.
That removes the reason `/.state/sync-v2` existed — this path design *is* v1.

- **State path is `/.state/sync`** (not `sync-v2`; the versioned name only made
  sense as a backward-compat reset, which we don't need). It is local-only per the
  `/.state/**` exclusion.
- **Forward compat via an explicit version field, not the path name.** The sync
  state carries a `schemaVersion` (state shape) and the `GET /fs` handshake returns
  `protocolVersion` (wire contract) alongside `schemaVersion` (see `/fs`
  transport). A client reads the handshake before syncing; a future breaking
  change bumps the field and branches on it — the stable path `/.state/sync` and
  the endpoint routes never change:

  ```ts
  type SyncState = {
  	schemaVersion: number        // 1 for this design; future migrations branch on it
  	pushCursor?: SyncCursor      // over the local ChangeSource
  	pullCursor?: SyncCursor      // over the remote's ChangeSource
  	// PathSyncState records are stored per-path under the same /.state/sync tree
  }
  ```

- **No self-heal claims.** We do **not** rely on old ino-forked replicas
  converging automatically; there are none to converge. A fresh install does one
  `pathScan` bootstrap and proceeds.

---

## Where the changes land (focused)

Contained to `packages/fs` + the `packages/core` fs transport; **kernel/apps
untouched**.

1. `packages/fs` — add `SyncMeta` / `PathChange` types and the **`SyncReplica`**
   interface. Add a **local `SyncReplica`** over `Volume`/`Storage`
   (`applyPathChanges`, `pathScan`, path journal per "Journaling"). `Storage`
   itself gains a minimal ordered **path-delta source** (the journal) and a
   **transactional path-apply seam** (`PathMutationStore`), not the wire protocol.
2. `packages/fs/synced.ts` — `push`/`pull`/`bootstrap` operate on `PathChange`
   via `SyncReplica`; state under `/.state/sync`, keyed by path
   (`PathSyncState` + tombstones); lazy `readFile` hydrates by `contentHash`.
3. `packages/core/src/fs.ts` — path-based endpoints per **`/fs` transport** above
   (`GET /fs/path/changes`, `GET /fs/path/snapshot`, `POST /fs/path/changes`,
   `PUT`/`GET`/`HEAD /fs/blob/:hash`). **Remove only the sync-specific** ino
   endpoints `/updates`, `/scan`, `/ops`. **Keep** the generic ino CRUD endpoints
   (`/inodes/:ino`, `/inodes/:ino/blob`, entries, xattrs) that back the general
   `apiStorage` Storage-over-HTTP client for non-sync direct access (#143 cleanup).
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
  `ContentHash` / `Version` / `DeltaPage` / `ScanPage` / `Handshake`,
  `SyncCursor`, `JournalRow` (with `localSource`), `PathSyncState`, `SyncState`
  (with `schemaVersion`)).
- All **interfaces** (`ChangeSource`, `SyncReplica`, `JournalStore`,
  `PathMutationStore` (the transactional path-apply seam), the native
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

- Write the RED tests from **Verification** below (RED 1–16) plus the
  deterministic property test.
- Cover the **major edge cases** explicitly: rename, directory move (subtree
  delete+put across a page boundary), parent-dir delete + concurrent descendant
  edit (ancestor resurrection), path reuse/replacement, type replacement (file↔dir
  with recursive delete ordering), tombstone then recreate, **dual-source echo
  suppression** (push `excludeLocalSource` vs pull `excludeOrigin`), snapshot
  paging + `pathDeltas(syncCursor)` resume with no gaps, idempotent scan/delta
  overlap, adoption same-path (incl. higher-remote-version), `/.state` **and**
  `/.state/**` never crossing the wire, total equal-version tie-break for
  dirs/symlinks and equal-content-different-mode files, `contentHash` schema
  invariants, bigint/base64 wire round-trip, lazy hydrate-by-hash.
- **Build test infra** where it helps: an in-memory `SyncReplica` harness,
  `twoPeers()` / `adoptionPeers()`, a numeric-ino backend, a seedable
  deterministic op generator.

At this stage **every test fails (red), and that's expected** — the Phase 0 bodies
still throw. Exit criteria: the suite is comprehensive and agreed; all red for the
right reason (`not implemented`), not from harness bugs.

### Phase 2 — implement until green

Bring the system online **one `TODO` at a time**, turning red tests green, until
the whole suite (RED 1–16 + property test) and the **Definition of done** pass.
No new surface area here — only filling in the bodies agreed in Phase 0 against the
tests written in Phase 1.

Exit criteria: all tests green; DoD satisfied; the incident (RED 1) is
reproduced-then-fixed.

---

## Spec nits to lock before coding (feedback)

- **Path normalization:** absolute paths only; normalise slashes; reject `..`;
  define Unicode normalisation + case sensitivity (recommend: NFC, case-
  sensitive, matching POSIX). Encoded once as the `SyncPath` schema (Wire shape).
- **Root path:** `/` is never the subject of a `PathChange` — it always exists and
  has no parent/name. `SyncPath` still accepts `/` (it is canonical), but the
  local `SyncReplica` **never emits a put/delete for `/` and rejects `delete('/')`
  on apply** (#143 cleanup); child paths under `/` are addressed normally.
- **Content hash format:** one canonical form — lowercase hex SHA-256 (64 chars),
  the `ContentHash` schema; blob store addresses it under `…/fs/blobs/sha256/`.
  Reject `sha256-`-prefixed or non-hex values. **Regular-file puts require a hash**
  (empty file = SHA-256 of empty bytes); **dirs/symlinks forbid it** — enforced by
  the `PathChange` schema refine (#143.4).
- **`SyncMeta.ctimeNs`:** intentionally omitted — ctime is POSIX-local; the
  applying replica sets it to apply-time and it never crosses the wire.
- **xattr semantics:** `SyncMeta.xattrs` is a COMPLETE snapshot, not a patch;
  apply replaces the whole user-xattr set; `trusted.sync.*` excluded both ways.
- **Push `source` untrusted:** the server stamps `PathChange.source` from the
  authenticated request context, not the body, on `POST /fs/path/changes` (#142.8)
  — robustness within a user's own device fleet (each DO is per-user), not a
  cross-tenant boundary.
- **Conflict tie-break is total AND stable (#143.3, re-review):**
  `(version, changeDigest)` where `changeDigest` is a canonical SHA-256 over the
  change's durable state only — `kind`, and for a put `type, mode, mtimeNs, size,
  symlinkTarget, sorted xattrs, contentHash`. It **excludes `source`** (server-
  stamped, hence unstable) and treats identical full-state changes as equal;
  `mtimeNs` is folded into the digest (not a separate key term) so deletes, which
  carry no meta, stay well-defined.
- **Version encoding (re-review):** `PathChange.version` is a **decimal string**
  (the `Version` schema), like `mtimeNs`/`size` — not `z.number()`. Avoids the
  2^53 ceiling and lets the value widen to bigint later with no wire change.
  **Persisted/internal versions are v1-bounded integers** (`path_version`,
  `PathSyncState`, `NativeIndexRow`); string is the wire boundary only. **Compare
  numerically, never lexicographically** (re-review 2).
- **Content materialisation is an explicit seam (re-review 1):** `applyJournaled`
  writes only tree metadata + `contentHash` ref, never bytes; `applyPathChanges`
  owns blobs out-of-band — eager `putBlobByHash` before apply, lazy defers to
  `readFile` hydration. Blob store is hash-addressed, so writes are idempotent and
  need no shared txn (orphans are GC'd; a missing blob is the lazy-stub state).
- **Ancestor resurrection metadata (re-review 3):** a resurrected synthetic dir is
  deterministic — `type=Directory, mode=0o755, xattrs={}, mtimeNs=max(surviving
  children), contentHash=none` — identical on every replica.
- **`SyncMeta.type`:** the `FileType` enum (`z.nativeEnum(FileType)`), not an
  arbitrary number.
- **Root path in schema:** `PathChange`'s refine rejects both `put('/')` and
  `delete('/')`; `/` is never a change subject.
- **Protocol handshake:** `GET /fs` returns `{ rootIno, protocolVersion,
  schemaVersion }` so clients negotiate before syncing (re-review forward-compat).
- **Generic ino-CRUD write sourcing (re-review):** writes through the retained
  `/inodes/*` endpoints journal `origin = MutationOptions.source ?? localActorId`
  and `localSource = NULL`; only the `PathMutationStore.applyJournaled` seam sets
  `localSource = REMOTE_SOURCE` and preserves a foreign origin. `MutationOptions.
  source` maps to **origin only**, never to `localSource`.
- **Transactional path-apply seam (re-review):** `applyPathChanges` goes through
  `PathMutationStore.applyJournaled`, not the public primitives, so tree mutation +
  journal row (exact incoming `version`/origin) + `localSource` + `path_version`
  fast-forward all commit in ONE backend transaction.
- **Ancestor delete vs descendant edit (#143.2):** per-path LWW decides each node;
  a surviving descendant then resurrects its ancestor directories (tree-repair
  pass) so the tree never has an orphan under a deleted dir.
- **Local-only paths:** one hard exclusion matching `/.state` **and** `/.state/**`
  in the local `SyncReplica` — never pushed, never applied, and reconcile ignores
  the prefix (#142.6, #143 cleanup) — replacing the `trusted.sync.local-only`
  xattr. No general user local-only feature in v1.
- **Apply ordering:** puts parent-before-child; deletes child-before-parent.
- **Type replacement:** define file↔dir replacement at a path (delete subtree
  then put) and recursive delete behaviour.
- **Echo suppression:** journal rows carry both the ORIGIN `PathChange.source` and
  a local `localSource`; `pathDeltas` exposes `excludeOrigin` (pull skips this
  client's authored changes) and `excludeLocalSource` (push skips sync-applied
  writes, e.g. `REMOTE_SOURCE`) (#143.1). There is no `sourceMode` flag.
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

### RED 10 — `/.state` and `/.state/**` never cross the wire (#142.6, #143)

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

### RED 13 — equal-version tie-break is deterministic for every node type (#143.3)

```ts
test('concurrent equal-version, equal-mtime writes pick the SAME winner on both sides', async () => {
	const { client, server, syncBoth } = twoPeers()
	// Equal version AND equal mtime: the tie-break must be TOTAL and STABLE — a
	// canonical digest of the change's DURABLE state (kind + meta + contentHash),
	// explicitly EXCLUDING the server-stamped `source` — so it resolves even where
	// the old key tied, and both replicas agree regardless of upload order:
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

### RED 14 — ancestor delete vs concurrent descendant edit (#143.2)

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

### RED 15 — schema invariants: hash, version encoding, type, root (#143.4, re-review)

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

### RED 16 — the conflict digest is source-independent (re-review)

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
- **Two `source` concepts are split in the journal (#143.1)** — wire `origin`
  (`PathChange.source`) vs local `localSource`; `pathDeltas` exposes
  `excludeOrigin` (pull) and `excludeLocalSource` (push). No `sourceMode` flag.
  `MutationOptions.source` maps to **origin only**; generic ino-CRUD writes journal
  `origin = source ?? localActorId`, `localSource = NULL` (re-review).
- **Remote apply goes through a transactional path-apply seam** —
  `PathMutationStore.applyJournaled` (owned by SQLite+IDB, alongside the journal),
  NOT the public primitives — so tree mutation, the journal row with the incoming
  `version`/origin verbatim, `localSource`, and the `path_version` fast-forward all
  commit in one backend transaction. It writes **metadata + `contentHash` ref
  only**; `applyPathChanges` materialises blobs out-of-band (eager `putBlobByHash`
  before apply, lazy on `readFile`) into the hash-addressed blob store (re-review 1).
- **The path journal lives at/below `Storage`** (not a bypassable `Volume`
  wrapper), translated to path-correct deltas with tombstones. **Directory move =
  ordered subtree delete+put in one txn**, needing a child→parent index for
  `pathOf` (#142.5).
- **Ancestor delete vs descendant edit has a tree policy (#143.2)** — per-path LWW
  then resurrect ancestors of surviving paths, with **deterministic synthetic dir
  metadata** (`mode 0o755`, empty xattrs, `mtimeNs = max(surviving children)`);
  tested (re-review 3).
- **Local-only state is excluded by path** — one hard rule matching `/.state`
  **and** `/.state/**` in the local `SyncReplica`, replacing the
  `trusted.sync.local-only` xattr (#142.6/#143); never pushed/applied, reconcile
  ignores it. No general user local-only feature in v1.
- **First-bootstrap same-path policy defined & tested** — keep local **and bump
  kept-local version above the remote** so the next push wins (#142.2/#142.3); the
  remote loser is overwritten, not copied — uniform with steady-state LWW.
- **Conflict = LWW-by-version + log everywhere in v1; no conflict copies** (steady
  state or bootstrap). `.sync-conflict` copies are the deferred follow-up (#142.2).
- **Lazy hydration is explicit on the local replica (#143.5)** — stubs retain the
  remote content hash and skip the blob fetch; eager mode fetches. Local blob
  presence is tracked separately (`hasBlobByHash`).
- **`pathScan` returns split cursors** — a `next` page token AND a `syncCursor`
  high-water frozen at scan start; documented and tested (paged bootstrap resumes
  `pathDeltas(syncCursor)` with no gaps; idempotent apply; post-scan reconcile
  deletes by **path**, not ino) (#142.1).
- **State lives at `/.state/sync` with an explicit `schemaVersion`**, and the
  `GET /fs` handshake returns `{ protocolVersion, schemaVersion, rootIno }` for
  forward compat; no auto-migration (unreleased product; old replicas are wiped)
  (#143, re-review).
- **Generic ino CRUD endpoints stay for `apiStorage`** (non-sync direct access),
  with defined journal sourcing (above); only sync-specific `/updates`,`/scan`,
  `/ops` are removed (#143).
- **Wire schema locked** — `SyncPath`/`ContentHash` schemas (not bare strings),
  `version` a **decimal string** not `z.number()` (persisted internally as a
  v1-bounded integer; **compared numerically, never lexicographically**),
  `SyncMeta.type` a `FileType` enum, `ctimeNs` intentionally omitted (synthesised
  on apply), `xattrs` a complete
  snapshot not a patch, **regular-file puts require a hash / dirs+symlinks forbid
  it**, and both `put('/')`/`delete('/')` are rejected (#142.7/#143.4, re-review).
- **Spec nits resolved** (normalization, root path, content-hash format, version
  encoding, apply ordering, type replacement, echo suppression, native caveats,
  hard links, orphaned-blob GC).
- Conflict resolution documented as a **deterministic winner** with a **total,
  source-independent tie-break** — `(version, changeDigest)` where `changeDigest`
  is a canonical hash of the change's durable state (`kind` + put meta), excluding
  the server-stamped `source` (#143.3, re-review).
- RED 1–16 pass (RED 5 in the materialiser doc), plus the deterministic property
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
- **No backward compat / no auto-migration (#143).** The product is unreleased;
  old replicas are wiped and recreated. State lives at the stable path
  `/.state/sync` (this design IS v1), with an explicit `schemaVersion` field
  carrying forward-compat rather than a versioned path name.
- **Remove only the sync-specific ino endpoints** (`/updates`, `/scan`, `/ops`) —
  deleted, not retained for debug. **Keep the generic ino CRUD endpoints**
  (`/inodes/:ino`, `/inodes/:ino/blob`, entries, xattrs) that back the general
  `apiStorage` Storage-over-HTTP client for non-sync direct access (#143).
