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
| Content (bytes) | **content hash** (`sha256-…`) | already: R2 key `…/fs/blobs/sha256/<hash>` |
| Local inode | **`ino`** — local only, never crosses the wire | unchanged |

`ino` remains exactly as it is. It is used only to *detect* local changes and to
*address local storage*, never to identify a file to a peer.

### Wire shape (path-keyed)

```ts
// The subset of InodeMeta that syncs. Note: NO ino.
export interface SyncMeta {
	type: FileType            // Regular | Directory | Symlink
	mode: number
	mtimeNs: bigint
	size: bigint
	symlinkTarget?: string
	xattrs?: Record<string, Uint8Array>   // excluding trusted.sync.* (local)
}

// A change to the tree, addressed by path. `contentHash` references a blob
// (undefined for dirs/symlinks). `version` drives generic LWW (see Conflicts).
export type PathChange =
	| { kind: 'put'; path: string; meta: SyncMeta; contentHash?: string; version: number; source?: string }
	| { kind: 'delete'; path: string; version: number; source?: string }
```

`source` carries the client-id so a replica filters its own echoes on pull (same
role as today's `MutationOptions.source` / `REMOTE_SOURCE`).

### The `SyncReplica` adapter (keep `Storage` lean — feedback #7)

Do **not** add path methods to `StorageCapabilities`. `Storage` stays the local
filesystem primitive. A separate adapter owns the path wire protocol; the local
and remote (HTTP) sides both implement it:

```ts
export interface SyncReplica {
	// Path-correct change source (see "Journaling"). Ordered, with tombstones.
	pathDeltas(cursor: string, opts?: { source?: string; sourceMode?: 'only' | 'exclude' })
		: Promise<{ changes: PathChange[]; cursor: string }>
	// Stable snapshot for bootstrap; captures the high-water cursor at scan start.
	pathScan(cursor: string): Promise<{ changes: PathChange[]; next: string; syncCursor?: string }>
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

### Journaling: path-correct, with tombstones (feedback #1)

**Do not resolve journal inos against the final tree state.** That loses deletes
(inode gone), renames (need the old path for the delete side), parent-dir deletes,
directory moves (all descendant paths change), and replaced paths (current path
points at a different ino than the historical op).

**Invariant (feedback R2.2): the journal must live at/below `Storage`, not only
in a `Volume` wrapper.** Today's change feed (`Storage.subscribe`) sits below the
Volume API precisely so direct-`Storage` writes and sync-applied writes are both
observed. A path journal in `volume.ts` alone would be **bypassed** by another
`volume(storage)` instance or a direct backend mutation → missed writes. So:

- **(B) Stateful sequential translation — preferred.** The path-delta source in
  the local `SyncReplica` consumes the existing `Storage` change feed/journal
  (which observes *all* mutations) and replays it **in order**, maintaining an
  `ino → path` map plus a tombstone set, deriving `PathChange`s as it goes. A
  directory move (parent repoint) walks the moved subtree to emit `delete(old
  subtree)` + `put(new subtree)`. The translator persists its map across cycles.
- **(A) Path journal at mutation time** is only acceptable if the invariant holds
  — i.e. *all* syncable mutations are forced through a single journaled wrapper
  and direct `Storage` mutation is internal-only. We reject this for now because
  it's easy to bypass; (B) is safer.

Either way, `pathDeltas` yields an **ordered** change list where a delete carries
the path being removed and a rename appears as `delete(old)` + `put(new)`.

Apply ordering (feedback nit): **puts parent-before-child; deletes
child-before-parent.**

### Blob push protocol (feedback #2)

Pull can `getBlobByHash` from the server. **Push cannot** — the server can't fetch
bytes from a browser by hash. Choose explicitly (this doc picks the second):

- inline changed-file bytes inside `POST /path-ops` (like today's `/ops` which
  inlines regular-file content — `fs.client.ts:94`/`:296`), **or**
- **`PUT /blob/:hash` first, then `POST /path-ops`** referencing hashes.

The server **must verify `sha256(bytes) === hash`** before accepting a blob, and
reject a `put` whose `contentHash` has no stored blob. Small files may inline as
an optimisation; large files upload first.

**Orphaned-blob GC (feedback nit):** a `PUT /blob/:hash` whose follow-up `POST
/path-ops` never lands leaves an unreferenced blob. Because blobs are content-
addressed, a periodic sweep can drop any stored hash not referenced by a live
path `contentHash` (mark-and-sweep against the tree). Define it as best-effort;
no correctness dependency.

### Conflicts & versioning

**One uniform policy for every path. The sync engine has no notion of app files
vs. user files — it never inspects paths like `/applications/**`.**

- Per-path `version` (a Lamport-style counter in a path-keyed sync-state record).
- Conflict (both sides changed since baseline) → a **deterministic winner**, not
  strictly "last write": highest `version`, tie-broken by `(mtimeNs, contentHash)`.
  (For true LWW under concurrent equal-version writes, widen the key to a
  `(version, mtimeNs, actorId)` tuple — deferred; v1 only needs determinism.)
- The losing side is preserved as a **conflict-copy** so no local work is lost
  (uniform for all paths; may be deferred to a later version — v1 could log +
  keep the winner).

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
(in `/.state`, itself local-only):

```ts
type PathSyncState = {
	path: string
	baselineVersion: number      // last agreed version at this path
	lastSeenHash?: string        // last agreed content hash
	tombstoneVersion?: number    // set when the path was deleted; survives recreate
}
```

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

`pathScan` captures a **high-water cursor at scan start over a stable snapshot**;
after applying the scan, the caller pulls `pathDeltas` after that cursor. `put`s
are **idempotent** (put path=meta+hash), so re-applying a write that landed both
in the scan and the post-scan delta is harmless. If a backend can't provide a
stable snapshot, document the fallback: capture cursor first, scan, then replay
deltas-from-cursor (idempotency covers overlap).

**Post-scan reconcile is by PATH, not ino (feedback nit):** after applying a full
`pathScan`, delete local paths **absent from the remote path snapshot** (the
adoption guard still gates whether reconcile runs at all — see First-bootstrap
policy). Today's `reconcileLocal` walks by ino; the path version deletes by path.

### First-bootstrap same-path policy

The adoption guard preserves a never-pushed profile's local work when it first
adopts a non-empty remote. Path identity makes the **same-path collision**
explicit: local (never-pushed) has `/x`, the remote snapshot also has `/x`.

**Uniform policy for every path** (no app/user distinction): treat it as a
conflict — keep local (adoption intent), and if content differs preserve the
remote as a **conflict-copy** (`x (conflict <ts>)`) so nothing is lost; the next
push ships local up. This is the same conflict rule as steady-state, applied at
bootstrap.

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
3. `packages/core/src/fs.ts` — new endpoints: `GET /path-updates`, `GET
   /path-scan`, `POST /path-ops` (inline or hash-ref), `PUT /blob/:hash`
   (verified), `GET /blob/:hash`. Deprecate ino-keyed `/updates`,`/scan`,`/ops`,
   `/inodes/:ino/blob` for sync (keep for admin/debug only).
4. `storage.fs.ts` (native) — reference backend proving ino stays a real-OS
   concept. Full participation needs content hashing + a path journal/delta source
   (future; see nits).

Non-goals for v1: version vectors, rename detection, user-file conflict copies,
partial-block transfer (whole blobs, keyed by hash; R2 dedupes).

---

## Spec nits to lock before coding (feedback)

- **Path normalization:** absolute paths only; normalise slashes; reject `..`;
  define Unicode normalisation + case sensitivity (recommend: NFC, case-
  sensitive, matching POSIX).
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
test('adoption bootstrap: keep local + conflict-copy the divergent remote (any path)', async () => {
	// Never-pushed local profile already has the path; remote snapshot differs.
	const { local, remote, bootstrapLocalFromRemote } = adoptionPeers()
	await local.writeFile('/notes/todo.md', bytes('LOCAL'))   // unpushed local work
	await remote.writeFile('/notes/todo.md', bytes('REMOTE'))
	await bootstrapLocalFromRemote()
	expect(text(await local.readFile('/notes/todo.md'))).toBe('LOCAL')      // adoption keeps local
	expect(await local.exists('/notes/todo.md (conflict)')).toBe(true)      // remote preserved
})
```
App bundles are not tested here — they follow the same uniform rule. "Stale app
bundle gets reconciled to newest" is a **materialiser** test
(`docs/app-materialization.md`), driven by the app-update watcher on top of sync.

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
- **Baselines/tombstones are stored by path** (`PathSyncState`), not inode xattrs.
- **`applyPathChanges` carries a local-apply `source`** (e.g. `REMOTE_SOURCE`),
  distinct from `PathChange.source` (origin client-id) — echo suppression and
  `volume.watch` preserved.
- **The path journal lives at/below `Storage`** (not a bypassable `Volume`
  wrapper), translated to path-correct deltas with tombstones.
- **First-bootstrap same-path policy defined & tested** — uniform (keep local +
  conflict-copy the divergent remote), no app/user split.
- **Lazy stubs retain the remote content hash** while separately tracking local
  blob presence (`hasBlobByHash`).
- **`pathScan` cursor semantics documented and tested** (high-water at scan start,
  idempotent apply; post-scan reconcile deletes by **path**, not ino).
- **Migration forces a `/.state/sync-v2` bootstrap.**
- **Spec nits resolved** (normalization, apply ordering, type replacement, echo
  suppression, native caveats, hard links, orphaned-blob GC).
- Conflict resolution documented as a **deterministic winner** (not strict LWW for
  concurrent equal-version writes).
- RED 1–7 pass (RED 5 in the materialiser doc), plus the deterministic property
  test.

---

## Sequencing

1. Ship the single-materialiser fix first (see
   [`docs/app-materialization.md`](./app-materialization.md)) — removes the
   common-case fork under today's ino sync.
2. This doc: path-based sync — makes forks structurally impossible and unblocks
   heterogeneous-backend sync (spud-mac ↔ frieren). It is a prerequisite for that
   roadmap, not gold-plating.

## Open questions

- `version`: scalar Lamport (simple, generic LWW) vs. version vector (detects true
  concurrency). Recommend scalar for v1. (No app awareness — app update policy is
  entirely the materialiser layer's concern.)
- User-file conflict policy: LWW-by-version + log vs. `.sync-conflict` copies.
- Keep ino-keyed HTTP endpoints for debug/admin, or remove entirely?
