# Path-based sync for `@justfiles/fs`

Status: proposal / design. No code yet. This doc is the artifact to pressure-test
before implementation.

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

This doc keeps the change focused to `packages/fs` + the `packages/core` fs
transport, defines the new shapes, and specifies red→green acceptance tests.

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
  never had**. Those parent inos did not exist on the DO at all.

Root cause: the two replicas minted **different inos for the same paths**
(`/applications`, `/system/tmp/app-installs`, `/applications/app.code`). Because
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
protocol (below) ships those local inos as if they were shared identity.

### Current wire shapes (ino-keyed) — the thing we're replacing

From `packages/fs/storage.ts`:

```ts
// Every sync op is keyed by ino. dirents bind (dirIno,name) -> child ino.
export type FsOp =
	| { kind: 'upsert-inode'; ino: Ino; meta?: Partial<InodeMeta>; xattrs?: Record<string, Uint8Array | null> }
	| { kind: 'set-dirent'; dirIno: Ino; name: string; ino: Ino; type: FileType }
	| { kind: 'unset-dirent'; dirIno: Ino; name: string; ino?: Ino }

export type ScanEntry = { ino: Ino; dirIno: Ino; name: string; meta: InodeMeta; xattrs?: Record<string, Uint8Array> }

interface StorageCapabilities {
	fullScan?(cursor: string): Promise<{ entries: ScanEntry[]; next: string; syncCursor?: string }>
	deltaUpdates?(cursor: string, options?: UpdateQueryOptions): Promise<{ ops: FsOp[]; cursor: string }>
	applyBatch?(ops: FsOp[], getBlob: (ino: Ino) => Promise<Uint8Array>, options?: MutationOptions): Promise<void>
	// getBlob/putBlob are also ino-keyed today.
}
```

`synced.ts` `push`/`pull`/`bootstrap` apply these ops verbatim on the peer,
trusting `ino` as shared identity. That is the bug.

---

## References (read these)

- **Dropbox — "Rewriting the heart of our sync engine" (Nucleus)** — why local
  filesystem identity can't be the sync identity; stable IDs; "same view before
  mutating"; move = delete+add is a trap; conflict-directory duplication.
  <https://dropbox.tech/infrastructure/rewriting-the-heart-of-our-sync-engine>
- **Syncthing FAQ** — path-based identity, `.sync-conflict` copies, "two
  independently-created folders don't merge unless you copy the Folder ID",
  rename handling. <https://docs.syncthing.net/users/faq.html>
- **Syncthing Block Exchange Protocol (BEP v1)** — index = `path → {version,
  blocks[]}`; content addressed by block hashes; version vectors for conflict.
  <https://docs.syncthing.net/specs/bep-v1.html>
- **Version vectors** (conflict detection between replicas).
  <https://en.wikipedia.org/wiki/Version_vector>
- **Git object model** — content-addressed blobs, path-addressed trees; the same
  split we're adopting. <https://git-scm.com/book/en/v2/Git-Internals-Git-Objects>

Takeaway shared by all mature systems: **the local filesystem inode stays local;
the cross-replica identity is either the path (Syncthing) or a stable id that is
neither path nor local-ino (Dropbox).** Given frieren's local-first / client-
authority stance and heterogeneous backends, **path** is the right identity.

---

## Design

### Two identity layers

| Layer | Identity | Where |
|---|---|---|
| Tree (dirs, names, meta) | **path** (`/applications/app.code/manifest.json`) | new sync boundary |
| Content (bytes) | **content hash** (`sha256-…`) | already: R2 key `…/fs/blobs/sha256/<hash>` |
| Local inode | **`ino`** — local only, never crosses the wire | unchanged |

`ino` remains exactly as it is (real-fs modelling preserved). It is used only to
*detect* local changes and to *address local storage*, never to identify a file
to a peer.

### Proposed wire shape (path-keyed)

Add a path-addressed change record used only at the sync boundary. Local storage
and its journal can stay ino-based; we **translate at the edge** (see "Where the
changes land").

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

// A change to the tree, addressed by path. contentHash references a blob;
// undefined for dirs/symlinks. `version` drives conflict resolution.
export type PathChange =
	| { kind: 'put'; path: string; meta: SyncMeta; contentHash?: string; version: Version }
	| { kind: 'delete'; path: string; version: Version }

// Monotonic per-path version. v1: a Lamport-style counter carried in a
// trusted.sync.* xattr + max(local, remote)+1 on write. (Version vectors are a
// later upgrade if we want true concurrent-edit detection; see "Conflicts".)
export type Version = number
```

Blobs are fetched by hash, not ino:

```ts
// remote transport (packages/core/src/fs.ts): GET /blob/:hash -> bytes
// content is already content-addressed in R2, so this is a rename of intent.
getBlobByHash(hash: string): Promise<Uint8Array>
```

### The sync loop, path-based

`synced.ts` keeps its shape (`push` → `pull`, cursors, `localFirst`, lazy
content) but operates on `PathChange`:

- **push(localCursor)**: read local journal deltas since `localCursor`; **resolve
  each changed ino to its current path(s)** (dir walk / `pathMap`), collapse into
  `PathChange[]` (last-write-per-path), send to remote. A `put` includes
  `contentHash`; the remote fetches the blob by hash if it doesn't have it.
- **pull(remoteCursor)**: get remote `PathChange[]`; for each, **resolve the path
  locally** (creating missing parent dirs), then:
  - `put`: upsert the local inode at that path (reuse the existing local ino if
    the path already exists — *in-place update, no identity churn*; otherwise
    mint a fresh **local** ino), set meta, and set content by `contentHash`
    (stub under lazy mode; hydrate on first read).
  - `delete`: remove the path (and recurse for dirs).
- **bootstrap()**: full path-addressed snapshot from remote; adoption guard
  unchanged (never-pushed profile merges remote in without destructive local
  reconcile).

Because identity is now the **path**, the server's `/applications/app.code`
overwrites the client's by path — **the existing fork self-heals on the next
bootstrap/pull.**

### Conflicts

Per path, compare `version` against a stored **baseline** (last agreed version,
kept in a `trusted.sync.baseline` xattr, as today but keyed by path resolution):

- No divergence → apply.
- Divergence (both changed since baseline):
  - **App bundles (`/applications/**`): last-writer-wins, monotonic — never
    downgrade** (higher `version` wins; tie-break by content hash). No user data
    to preserve.
  - **User files: conflict-copy** (Syncthing-style `name (conflict <ts>).ext`)
    — deferred; v1 may LWW-by-mtime and log, since the immediate need is apps.

`version` as a scalar Lamport counter is enough for LWW. Upgrade to a **version
vector** only if/when we need to *detect* true concurrency vs. stale (that's the
BEP model; scope it later).

### Renames

v1: **delete + put** (correct under path identity). Rename *detection* (match a
delete+put pair by identical `contentHash` to preserve local ino / avoid re-
transfer) is a later optimisation — the blob is content-addressed so it isn't
re-uploaded regardless.

### Migration / self-heal

- Existing replicas: first path-based bootstrap reconciles by path. The forked
  `/applications/*` on the incident's browser converges to the server's version
  (newer). No manual reset needed once shipped.
- The DO's server-side "skipped dangling set-dirent" self-heal becomes moot for
  the tree (there are no cross-replica inos to dangle); keep it as defence.

---

## Where the changes land (focused)

Contained to two packages; **kernel/apps untouched**.

1. `packages/fs/storage.ts`
   - Add `SyncMeta`, `PathChange`, `Version` types.
   - Add caps: `pathDeltas(cursor) → { changes: PathChange[]; cursor }` and
     `applyPathChanges(changes, getBlobByHash)`; `pathScan(cursor)` for
     bootstrap. Implement by **translating** the existing ino-journal at the edge
     (push: ino→path; pull: path→local ino). Keep `FsOp`/`deltaUpdates` internal
     to each backend; they no longer cross the wire.
2. `packages/fs/synced.ts`
   - `push`/`pull`/`bootstrap`/`reconcileLocal` operate on `PathChange`.
   - Baselines keyed by path; `hasConflict` compares `version` not `ino` content
     hash.
   - Lazy `readFile`: hydrate by `contentHash` (fetch `getBlobByHash`), not by
     ino.
3. `packages/core/src/fs.ts` (HTTP transport)
   - New endpoints: `GET /path-updates`, `GET /path-scan`, `POST /path-ops`,
     `GET /blob/:hash`. Deprecate the ino-keyed `/updates`, `/scan`, `/ops`,
     `/inodes/:ino/blob` for sync (they can remain for admin/debug).
4. `storage.fs.ts` (native): already has `pathMap`; it's the reference backend
   proving ino stays a real-OS concept while sync speaks paths.

Non-goals for v1: version vectors, rename detection, user-file conflict copies,
partial-block transfer (we ship whole blobs keyed by hash; R2 dedupes).

---

## Verification: red → green (TDD)

Tests live in `packages/fs/synced.test.ts` (extend the existing mem-storage
harness). Each test below **fails against today's ino-based sync (RED)** and must
**pass after the path-based change (GREEN)**. Run with `pnpm vitest run
packages/fs/synced.test.ts`.

Helper: `twoPeers()` builds two independent `Storage` backends (each mints its
own inos) wired through a fake remote transport, and a `sync(a→remote), sync(b←
remote)` pump.

### RED 1 — the fork heals (the incident)

```ts
test('same path independently created on both sides converges (no fork)', async () => {
	const { client, server, syncBoth } = twoPeers()
	// Both independently create /applications/app.code/manifest.json with
	// DIFFERENT local inos and DIFFERENT content (client older, server newer).
	await server.writeFile('/applications/app.code/manifest.json', bytes('v0.1.1'))  // version 2
	await client.writeFile('/applications/app.code/manifest.json', bytes('v0.1.0'))  // version 1
	await syncBoth()
	// Path identity + monotonic LWW: server (higher version) wins on both.
	expect(text(await client.readFile('/applications/app.code/manifest.json'))).toBe('v0.1.1')
	// Exactly one entry — no duplicate/phantom subtree.
	expect((await client.readdir('/applications/app.code')).map((e) => e.name)).toEqual(['manifest.json'])
})
```
RED today: the client keeps `v0.1.0` (its ino), server's op lands on a phantom
parent → never converges.

### RED 2 — heterogeneous ino spaces sync (unblocks spud-mac)

```ts
test('syncs between numeric-ino (native-like) and uuid-ino backends', async () => {
	const native = memStorage({ mintIno: numericIno })  // "2","3",… like real OS inodes
	const uuid   = memStorage({ mintIno: uuidIno })
	const { syncBoth } = wire(native, uuid)
	await native.writeFile('/data/note.txt', bytes('hello'))
	await syncBoth()
	expect(text(await uuid.readFile('/data/note.txt'))).toBe('hello')  // arrives by PATH
})
```
RED today: impossible — `set-dirent` carries native inos the uuid backend can't
place.

### RED 3 — update is in-place, not identity churn

```ts
test('updating a file at a path keeps a single entry and converges', async () => {
	const { client, server, syncBoth } = twoPeers()
	await server.writeFile('/applications/app.code/gui.js', bytes('v1')); await syncBoth()
	await server.writeFile('/applications/app.code/gui.js', bytes('v2')); await syncBoth()
	expect(text(await client.readFile('/applications/app.code/gui.js'))).toBe('v2')
	// No orphaned inodes accreted from re-materialising the subtree.
	expect(await orphanCount(client)).toBe(0)
})
```
RED today: the atomic tmp+rename install re-mints the subtree; updates churn inos
and leave orphans.

### RED 4 — deletes propagate by path (the Dropbox intuition)

```ts
test('deleting a path on one side removes it on the other', async () => {
	const { client, server, syncBoth } = twoPeers()
	await server.writeFile('/applications/x/app.js', bytes('a')); await syncBoth()
	await server.rm('/applications/x', { recursive: true }); await syncBoth()
	expect(await client.exists('/applications/x')).toBe(false)
})
```

### RED 5 — monotonic LWW never downgrades

```ts
test('a stale peer cannot downgrade a newer version', async () => {
	const { client, server, syncBoth } = twoPeers()
	await server.writeFile('/applications/app.code/manifest.json', bytes('0.1.1')) // v2
	await syncBoth()
	await client.writeFile('/applications/app.code/manifest.json', bytes('0.1.0')) // v1 (stale build)
	await syncBoth()
	// server's newer version stands on both; client's downgrade is rejected.
	expect(text(await server.readFile('/applications/app.code/manifest.json'))).toBe('0.1.1')
	expect(text(await client.readFile('/applications/app.code/manifest.json'))).toBe('0.1.1')
})
```

### RED 6 — lazy content hydrates by hash

```ts
test('pulled file is a stub, first read hydrates by content hash', async () => {
	const { client, server, syncBoth } = twoPeers({ lazyContent: true })
	await server.writeFile('/applications/app.code/gui.js', bytes(BIG)); await syncBoth()
	// stub: metadata present, no local blob yet
	expect((await client.stat('/applications/app.code/gui.js')).size).toBe(BigInt(BIG.length))
	expect(await client.hasLocalBlob('/applications/app.code/gui.js')).toBe(false)
	expect(text(await client.readFile('/applications/app.code/gui.js'))).toBe(BIG) // fetch by hash
	expect(await client.hasLocalBlob('/applications/app.code/gui.js')).toBe(true)
})
```

### GREEN — regression guardrails to keep

- Existing `synced.test.ts` cases (push/pull/bootstrap/adoption/lazy) still pass,
  rewritten to the path API.
- Property test (small, deterministic-seeded, à la Nucleus): generate random
  sequences of `writeFile/rm/rename/mkdir` on two peers, sync, and assert **both
  trees are byte-identical by path** and **no orphaned inodes**. This is where
  sync bugs hide; frieren's small volumes make it cheap.

Definition of done: RED 1–6 pass; the property test holds over N seeds; the
incident is reproducible as RED 1 and fixed as GREEN.

---

## Sequencing

1. **Now, independent of this doc:** fix the app-materialisation bug with the
   single-materialiser rule (server-authoritative for synced profiles; client for
   local-only; drop-and-adopt on transition) and restore the reconcile per-file
   self-heal regressed by the `.apphash` change. This unblocks users without the
   sync rewrite.
2. **This doc:** path-based sync. It makes the fork structurally impossible and is
   a **prerequisite** for spud-mac ↔ frieren sync (heterogeneous ino spaces) —
   not gold-plating.

## Open questions

- `Version`: scalar Lamport counter (simple, enough for LWW) vs. version vector
  (detects true concurrency). Recommend scalar for v1.
- User-file conflict policy: LWW-by-mtime + log vs. `.sync-conflict` copies.
  Recommend deferring; apps use monotonic LWW.
- Keep ino-keyed HTTP endpoints for debug/admin, or remove entirely?
