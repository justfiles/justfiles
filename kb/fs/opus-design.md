# packages/fs — access patterns, minimal data, minimal seam

Status: research report. No code changed.
Question asked: is the "close mimic of a real Linux filesystem" model wrong for this system?
Answer: yes, for the half of the work that sync does. This report shows why, and what to
replace it with.

---

## 0. Summary

The current design keeps **three identities for one object**, **three descriptions of one
change**, and **three descriptions of one object's state**. Each new feature must be taught to
every member of every group. This is why one ignore list costs 3,555 added lines across 35 files
(PR #494). The cost is not the feature. The cost is the number of places that must learn it.

The proposal is one record type and one table:

```
node = (id, parent, name, type, mode, mtime, size, hash?, target?, xattrs?, deleted, rev, base, seq)
```

Path is derived from the parent chain. The change feed is the `seq` column. The snapshot is the
same query with cursor 0. Sync is three pure functions over these rows.

Result: the backend contract goes from about **60 methods across 8 interfaces** to
**10 methods across 3 interfaces**, one of which is optional. The public `Volume` API does not
change at all.

---

## 1. Diagnosis — why the seam grows

### 1.1 Three identities for one object

| Identity | Defined in | Answers |
| --- | --- | --- |
| `Ino` | `types.ts` | which bytes and which metadata |
| `(dirIno, name)` dirent | `storage.ts` | where the object is |
| `SyncNodeId` | `sync/node.ts` | which object, across replicas |

POSIX splits inode from dirent because POSIX has hard links: many names, one inode.
`storage.ts` states that **this system forbids hard links**. So the split buys nothing here.
It only costs: every sync concept must join two tables, then map the result to a third identity.

The third identity is also redundant today. `storage.idb.ts:405`, `storage.mem.ts:64` and
`storage.sqlite.ts:158` all mint an `Ino` with `crypto.randomUUID()`. `newNodeId()` in
`sync/node.ts:43` mints a `SyncNodeId` with `crypto.randomUUID()`. The `NodeStore.idFor()` map
and the `NodeState.localIno` field exist to map **one random UUID to another random UUID**.
They also force `bindRoot()`, a well-known root id, and a root-binding step in every apply path.

### 1.2 Three descriptions of one change

| Type | Lives in | Lifetime |
| --- | --- | --- |
| `TreeEffect` | `storage.shared.ts` | inside the transaction |
| `StorageChange` | `storage.ts` | in memory, for `watch` |
| `NodeMutation` / `NodeJournalRow` | `sync/node.ts` | durable, for `since` |

The three carry the same facts in three shapes. `StorageChange` even has a `path` field with the
rule "an absent path means unknown, so a scoped listener must assume the worst and fire". That
rule exists only because a change object is not the object that changed.

### 1.3 Three descriptions of one state

`InodeMeta` (9 fields) + `DirentMin` (2) + `NodeState` (9) + `SyncMeta` (7) = 27 fields across 4
types, for one node. `nextState()` folds mutations into `NodeState`. `syncMetaFromInode()` and
`inodeMetaFromSync()` convert between two of the four. `ctimeNs` needs a written exception on the
wire because it is local. `uid` and `gid` are in `InodeMeta` and no caller in the repository
reads them.

### 1.4 The measured surface

| Interface | File | Methods |
| --- | --- | --- |
| `Storage` | `fs/storage.ts` | 9 |
| `StorageCapabilities` | `fs/storage.ts` | 11 |
| `ContentStore` | `fs/storage.ts` | 4 |
| `TreePort` | `fs/storage.shared.ts` | 13 |
| `MutationObserver` | `fs/storage.shared.ts` | 1 |
| `NodeStore` | `sync/node.ts` | 10 |
| `NodeSyncModule` | `sync/node.ts` | 4 |
| `SyncCapability` | `sync/node.ts` | 8 |
| **Total (v2 path only)** | | **60** |

Add protocol v1 (`ChangeSource`, `ChangeApplier`, `BlobStore`, `LineagePeer` in
`sync/replica.ts`) and the `strategy.ts` matrix of four strategies. A backend author must
understand all of it. `storage.sqlite.ts` is 2,069 lines. `storage.idb.ts` is 1,047 lines.

### 1.5 The root cause

A real filesystem is built for **path-forward** access. Sync is **id-forward** and
**change-ordered**. The current design serves the first from `(inode, dirent)` and bolts the
second on top with a parallel identity and a parallel journal. Every feature then has to cross
the bolt.

---

## 2. Deliverable 1 — the full access pattern

`POSIX?` says whether a real filesystem serves the pattern. This is the direct answer to
"is mimicking a real filesystem helping or hurting".

| # | Access pattern | Callers | Key | Result | Cost target | POSIX? |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | Resolve one path segment | every `Volume` call | `(parent, name)` | one node | O(1) per segment | yes |
| A2 | Read node state | `stat`, `lstat`, `exists` | `id` | one node | O(1) | yes |
| A3 | List a directory | `readdir` | `parent` | nodes, paged | O(children) | yes |
| A4 | Read bytes | `readFile` | `hash` | bytes | O(size) | yes |
| A5 | Replace bytes | `writeFile` | `id` | new `hash` | O(size) | yes |
| A6 | Patch bytes | `appendFile`, `writeRange` | `id`, offset | new `hash` | O(patch) wanted | yes |
| A7 | Claim a name atomically | `writeFile{exclusive}`, `mkdir` | `(parent, name)` | success or EEXIST | 1 transaction | yes |
| A8 | Move a name | `rename` | `id` | 1 row changed | **O(1) in subtree size** | yes |
| A9 | Remove a subtree | `rm -r` | root `id` | N rows changed | O(N) | yes |
| A10 | Walk a subtree | `scan` | root `id` | nodes, paged | O(N) | yes |
| A11 | Node to path | `watch` scope, ignore test, UI | `id` | string | O(depth) | **no** |
| A12 | Changes after a point | sync push, `watch` | `seq > c` | nodes, ordered, paged | O(changed) | **no** |
| A13 | Complete current state | bootstrap, snapshot | all rows | nodes, paged | O(N), no transaction | **no** |
| A14 | Merge a foreign node | sync apply | `id` | upsert | O(1) per node | **no** |
| A15 | Is this content present | blob transfer, dedupe | `hash` | boolean | O(1) | **no** |
| A16 | Read a tombstone | reconcile, resurrect check | `id` | one node | O(1) | **no** |
| A17 | Notify after commit | `watch` | — | new `seq` | push, coalesced | partly |
| A18 | Read and write xattrs | ghostore | `id` | bytes map | O(1) | yes |
| A19 | Order writes per file | `appendFile` | `id` | — | in process | yes |

### 2.1 What this table says

POSIX serves A1 to A10, A18 and A19. POSIX denies A11 to A16.

The denied set is exactly the set that sync lives on. A real filesystem has no stable id you can
open, no ordered change log, no paged full state, and no way to say "put this node here, with
this id". Every one of those had to be added on the side, with its own identity, its own journal,
its own snapshot session, and its own reconciliation path.

So the premise is half right. The *outward* shape must stay POSIX, because that is what agents
and `just-bash` know. The *inward* structure must not, because the inward structure has to serve
A11 to A16 as first-class queries, not as add-ons.

### 2.2 Where the patterns collapse

- A12 and A13 are the same query. A snapshot is `since(0)`.
- A2, A14 and A16 touch the same row. A tombstone is a node with `deleted = true`.
- A1 and A3 use the same index, `(parent, name)`.
- A11 is a walk over the same rows A1 uses.
- A15 belongs to the blob store, not to the node store.

Nineteen patterns need **four indexes and one blob map**:

| Index | Serves |
| --- | --- |
| primary key `id` | A2, A14, A16 |
| unique `(parent, name)` where live | A1, A3, A7 |
| `seq` | A12, A13, A17 |
| parent chain walk (uses the first two) | A9, A10, A11 |
| blob map `hash -> bytes` | A4, A5, A6, A15 |

---

## 3. Deliverable 2 — the minimal data structure

Two structures. Nothing else.

```ts
type NodeId = string          // UUID, minted by the creator, never reused
type Hash = string            // lowercase hex sha-256 of the bytes

type Node = {
	// identity and place
	id: NodeId
	parent: NodeId | null       // null only for the root
	name: string                // '' only for the root

	// payload — the store never reads these
	type: 'file' | 'dir' | 'link'
	mode: number
	mtime: bigint
	size: bigint
	hash?: Hash                 // files only
	target?: string             // links only
	xattrs?: Record<string, Uint8Array>

	// state
	deleted: boolean            // a tombstone keeps the row
	rev: number                 // agreed version — the merge term
	base: number                // last rev a peer confirmed — the push filter
	seq: number                 // local commit order — the cursor term
}

// the second structure
type Blobs = Map<Hash, Uint8Array>
```

Fourteen fields. Today the same information needs 27 fields across four types.

### 3.1 Everything else is derived

| Concept | Derivation |
| --- | --- |
| path of a node | join the `name` values up the `parent` chain |
| the tree | the `parent` relation |
| a directory listing | live rows with `parent = id` |
| the change feed | rows with `seq > cursor`, in `seq` order |
| a full snapshot | rows with `seq > 0` |
| a tombstone | a row with `deleted = true` |
| "not yet pushed" | a row with `rev !== base` |
| an ignored node | a predicate on the derived path |
| a conflict | `merge(mine, theirs)` on one row |

Nothing in this list needs a new table, a new identity, or a new protocol message.

### 3.2 The only three invariants

- **I1** — exactly one row per `id`.
- **I2** — at most one live row per `(parent, name)`.
- **I3** — the `parent` chain of a live row ends at the root, inside a depth limit.

### 3.3 The property that makes this safe

**A row that breaks I2 or I3 is invisible, not corrupt.**

Path is derived, so a node with a broken chain simply does not resolve. A cycle, a lost parent, a
duplicate name, or a half-applied batch all give the same result: the node is not reachable, and
the tree around it is still correct. No merge can damage the tree. This is the property the
current design cannot have, because the tree is stored as dirent rows that a bad write really
does corrupt.

Handling the failures then costs almost nothing:

- **Cycle** — the chain walk hits its depth limit. The node is invisible. A depth limit is
  already needed for symlink loops.
- **Name collision** — resolve picks the lower `id`. The other row is invisible. The rule is the
  same on every replica, so every replica agrees.
- **Missing parent** — the node is invisible until the parent arrives.

An authority still rejects a cycle or a collision at accept time, so the visible state is clean.
The invariant above is what makes a *follower* safe without that check.

### 3.4 The two counters

`rev` and `seq` are different facts and both are needed.

| Field | Meaning | Assigned by | Used for |
| --- | --- | --- | --- |
| `rev` | version of this node, agreed between replicas | the authority | merge, CAS, conflict |
| `base` | the last `rev` a peer confirmed for this node | sync, on accept | push filter, echo suppression |
| `seq` | position of this row in this replica's commit order | the store | cursors, `watch` |

`base` removes the echo problem without a `source` column on the journal. A row that sync applied
has `rev === base`, so push skips it. A row a user edited has `rev !== base`, so push sends it.
Today this needs `localSource` on `NodeJournalRow`, plus `excludeLocalSource` threaded through
`nodeDeltas`, `captureDeltas` and the replica.

### 3.5 Fields that are removed and why

| Field | Reason |
| --- | --- |
| `ctimeNs` | POSIX forbids userspace from setting it, so it can never cross the wire. The wire already carries a written exception for it. Let the store stamp its own row-touched time. |
| `uid`, `gid` | No caller in the repository reads them. |
| `Ino` as a separate id | Every syncing backend already mints a UUID for it. |
| `contentHash` on two types | One `hash` field on one row. |
| `nlink` and reference counting | Hard links are already forbidden. |

---

## 4. Deliverable 3 — the minimal implementation seam

This is the complete contract a backend must satisfy. SQLite, IndexedDB, memory and a native
filesystem sidecar all implement it directly.

```ts
interface Store {
	/** Run reads and writes as one atomic unit. */
	tx<T>(fn: (t: Tx) => Promise<T>, opts?: { source?: string }): Promise<T>

	/** Content, keyed by its hash. */
	blob: {
		get(hash: Hash): Promise<Uint8Array | null>
		put(hash: Hash, data: Uint8Array): Promise<void>
		has(hash: Hash): Promise<boolean>
		/** Remove blobs no live row names. Not on the read or write path. */
		gc(): Promise<{ reclaimed: number; done: boolean }>
	}

	/** Called after each commit. Optional; without it, callers poll `since`. */
	watch?(fn: (seq: number, source?: string) => void): () => void
}

interface Tx {
	get(id: NodeId): Promise<Node | null>
	at(parent: NodeId, name: string): Promise<Node | null>
	list(parent: NodeId, after: string, limit: number): Promise<Node[]>
	since(seq: number, limit: number): Promise<Node[]>
	/** Upsert. The store stamps `seq` at commit. */
	put(node: Omit<Node, 'seq'>): void
}
```

**Ten methods across three interfaces. One is optional.**

### 4.1 The rules the store must obey

Three rules. Nothing more.

1. **`tx` is atomic.** All `put` calls in one `tx` commit together, or none do.
2. **`seq` never goes backwards for a reader.** After `since(c)` returns a page, the store must
   never later produce a row with `seq <= c`. A single-writer store (SQLite, an IndexedDB
   readwrite transaction) gets this for free, because `seq` is assigned under the write lock.
   A multi-writer store must publish a safe watermark instead of a raw counter.
3. **The store reads only `id`, `parent`, `name`, `deleted` and `seq`.** Every other field is an
   opaque value. A SQL backend may promote fields to real columns for its own indexes. That
   choice is invisible at the seam.

Rule 3 is what keeps the contract small and keeps the meaning in one place. Sync owns `rev` and
`base`; the store just stores them.

### 4.2 What the core builds on top

`TreePort`'s 13 methods become 13 plain functions over `Tx`, written once, shared by every
backend:

`pathOf`, `resolvePath`, `ensureDirPath`, `listSubtree`, `linkNode`, `unlinkNode`, `moveNode`,
`upsertNode`, `readNode`, `hasLiveChildren`, `tombstoneSubtree`, `resolveSymlink`, `mintId`.

`volume.ts` keeps its path resolution, symlink loop limit, caches and per-inode write ordering,
and calls those functions instead of `Storage`.

### 4.3 Atomic create becomes free

Today `atomicCreate(dirIno, name, meta, content)` needs a 40-line comment explaining why the
backend, not the VFS, must stage bytes, and every backend must honour it.

With hash-addressed blobs the order is forced and safe:

1. Hash the bytes. This commits nothing.
2. `blob.put(hash, bytes)`. A blob no row names is a harmless orphan; `gc` reclaims it.
3. `tx(t => t.put(node))`. One row, one commit.

A reader that resolves the name always finds a `hash` whose blob is already stored. There is no
window where a name holds a prefix. The capability, its parameter, and its whole doc comment go
away.

### 4.4 Sync becomes three pure functions and a transport

```ts
/** 1. Visibility. One predicate, one place. */
type Project = (path: string) => boolean

/** 2. Conflict. Swap this to change topology. */
type Merge = (mine: Node | null, theirs: Node) => Node | null

/** 3. Transport. */
interface Peer {
	pull(cursor: string, limit: number): Promise<{ nodes: Node[]; cursor: string; done: boolean }>
	push(nodes: Node[]): Promise<{ accepted: Node[]; rejected: Reject[] }>
	getBlob(hash: Hash): Promise<Uint8Array>
	putBlob(hash: Hash, data: Uint8Array): Promise<void>
}
```

The whole loop:

```
push:  for each row in since(pushCursor) where rev !== base and Project(path(row)):
           send it; on accept, write back rev and base

pull:  for each row in peer.pull(pullCursor) where Project(path(row)):
           fetch its blob if hash is unknown; put(merge(get(row.id), row))
```

Both directions are the same loop, with the same filter, over the same rows.

### 4.5 This answers the three requirements

**Requirement 1 — looks like a real filesystem.** `Volume` does not change. `volume.ts` keeps its
current public surface, so `just-bash`, the agent tools and every app keep working. Only what is
behind `Volume` changes.

**Requirement 2 — sync is invisible and solid.** Sync writes the same rows the user writes. There
is no second store to keep in step, so there is no drift to repair. A snapshot needs no
transaction, because every row is self-describing and idempotent: if a page reads a stale row,
the delta repeats it; if it reads a new row, the delta repeats it again. Repeating is a no-op.

**Requirement 3 — the topology is composable.** Change the type of `rev` and the body of `Merge`.
Nothing else changes.

| Topology | `rev` | `Merge` |
| --- | --- | --- |
| server authority (today) | number from the server | higher `rev` wins |
| last write wins | Lamport counter | higher `(rev, id)` wins |
| peer to peer | version vector | vector compare, then a fixed tiebreak |

The row shape, the store, the transport and the loop are identical in all three.

---

## 5. Review pass — can this be smaller?

I made a second pass over the seam and removed five more things.

| Removed | Why |
| --- | --- |
| `fullScan` capability | `scan` is recursive `list`. Same O(N), one fewer method. |
| `pathOf` as a seam method | It is a chain walk over `get`. The core does it. |
| a hash index on nodes | Only `blob.has` and `gc` need it. `gc` is store-internal. |
| `StorageChange` (7 fields) | The notification carries only the new `seq`. The listener reads the rows. |
| a `source` column on the row | `source` describes the commit, not the node. It rides on `tx` and on the `watch` callback. |

I could not remove these, and here is why each has to stay:

- **`at(parent, name)`** is `list` with a filter, but path resolution runs it once per segment on
  every call. It gets its own point lookup.
- **`base`** could be a separate table, which is worse: it would be a second row to keep in step,
  and that is the mistake this whole report is about.
- **`gc`** is not needed for correctness — an orphan blob is harmless — but disk fills.
- **`watch`** is optional, and a store without it still works by polling.
- **`seq` and `rev`** are local order and global version. One number cannot be both.

Five methods on `Tx`, four on `blob`, one on `Store`. I do not see a tenth thing to cut without
making a caller do something unsafe.

---

## 6. What disappears from the current code

Concepts, not line counts. The files are listed to show the scale of the surface each concept
occupies today.

| Concept today | Where | Replaced by |
| --- | --- | --- |
| `Ino` to `SyncNodeId` map, `localIno`, `idFor`, `bindRoot`, `ROOT_NODE_ID` | `sync/node.ts` | one `id` |
| dirent table, `getDirent`/`putDirent`/`deleteDirent`/`listDirents` | `fs/storage.ts` | `parent` and `name` columns |
| `deleteInode` and its "no-op if still referenced" rule | `fs/storage.ts` | `deleted` flag; no hard links, so no counting |
| `TreeEffect`, `MutationObserver`, `TreePort` (13 methods) | `fs/storage.shared.ts` | the store commits rows; the rows are the log |
| `NodeJournalRow`, `append`, `read`, `head`, `compactNodeJournal` | `sync/node.ts` | the `seq` column and `since()` |
| `NodeMutation` (4 kinds), `nextState` fold | `sync/node.ts` | the row is the state; no fold |
| `NodeOperation`, `operationId`, `getOperation`, `saveOperation` | `sync/node.ts` | upsert by `(id, rev)` is already idempotent |
| snapshot sessions: `SnapshotView`, `Busy`, `Restart`, `Close`, blob retention | `sync/node-snapshot.ts` (195 lines) | `since(0)`; no transaction needed |
| `pathScan` and `nodeDeltas` as two calls | `sync/replica.ts`, `sync/node.ts` | one `since()` |
| protocol v1 (path) beside protocol v2 (node) | `sync/path.ts`, `sync/wire.ts` (778 lines) | one protocol |
| `StorageCapabilities` tiers and the 4-strategy matrix | `fs/storage.ts`, `sync/strategy.ts` | one store contract |
| `atomicCreate` with its `content` parameter | `fs/storage.ts` | blob first, then one row |
| `wantedContent`, `retainContent`, `captureDeltas`, staged and outgoing blob maps | `sync/node.ts` | the receiver asks for hashes it does not have |
| `syncMetaFromInode` / `inodeMetaFromSync`, the `ctimeNs` exception | `sync/wire.ts` | the row is the wire shape |
| ignore-policy reconciliation as its own epic | PR #494, 35 files | a predicate, plus a cursor reset |

### 6.1 The ignore list, sized against the new model

This is the case that started the question, so it is worth checking directly.

| Step | Today | Proposed |
| --- | --- | --- |
| filter the wire | one place per direction per protocol | `Project` in the push loop and the pull loop |
| filter the snapshot | snapshot session must apply it | the snapshot **is** `since(0)`, same loop, same filter |
| filter tombstones | separate path | a tombstone is a row |
| policy changed | a resumable reconciliation engine | set both cursors to 0 |
| repair after a policy change | bespoke compare and repair | the normal loop, which is idempotent |
| ignored to visible move | `publishTree` with a manifest | the rows become visible and push sends them |
| visible to ignored move | `unpublishTree` with a manifest and exact validation | the rows stop matching `Project`; push sends tombstones for ids the peer knows |

The reason a cursor reset is enough is that the loop is idempotent and the rows are
self-describing. Today a reset is unsafe, so a separate reconciliation engine had to be built.

One real cost stays: a policy change means a full re-read of both sides. That is O(N) once, and
it is a rare, user-triggered event.

---

## 7. Prior art

| Source | Idea taken | Idea left |
| --- | --- | --- |
| **Kleppmann et al., 2020, "A Highly-Available Move Operation for Replicated Trees"** | The row **is** `(id, parent, name, payload)`. A move is one operation. Cycles are the only invariant a per-node merge can break. | The undo/redo log. An authority check is enough for a client-server topology. |
| **Dropbox Nucleus** | A server-assigned monotonic revision, and block-level content hashing for large files. | The three-tree planner. The earlier sync-node-identity design already rules it out. |
| **Google Drive Changes API, Microsoft Graph delta** | One `since(cursor)` call that returns **full item state, not diffs**, including tombstones. This is the strongest confirmation that self-describing rows plus one cursor is the right shape. | Their per-file ACL model. |
| **Syncthing (BEP)** | Per-device sequence numbers as the cursor. | Path identity. It makes every rename a delete plus a create — the exact cost this work is trying to remove. |
| **Git** | Content addressing for bytes. | Tree objects as identity. A rename rewrites every ancestor tree, which is the O(depth) write fanout the earlier sync-node-identity design explicitly rejects. |
| **Perkeep permanodes** | One stable id per logical object, minted by its creator, never reused, separate from its content. | Claim logs as the storage model. |
| **Unison** | "What I last agreed with" is a per-node field. That is `base`. | A separate archive tree. Put the field on the row. |
| **Hypercore / Hyperdrive** | The log is the source of truth and the tree is a view over it. | An unbounded log. One row per node with a `seq` column is the same view with the log pruned. |
| **Linux VFS (inode + dentry)** | The outward API shape. | The split itself. It exists for hard links and for the dcache, and neither applies here. |
| **SQLite and IndexedDB** | Both give exactly transaction, point get, and index range scan. The seam in section 4 is what these substrates already do. | — |

---

## 8. Risks and open questions

### 8.1 Ranged writes against immutable content — the one real tension

Content addressing wants immutable bytes. `write(2)` and `appendFile` want to patch in place.

| Option | Cost | Note |
| --- | --- | --- |
| (a) read, patch, write the whole blob, rehash | O(size) per write | This is what the current fallback already does when `writeRange` is absent. |
| (b) mutable bytes per node, hash computed on demand | fast writes, O(size) before publish | A node with no hash has not been published. |
| (c) `hash` names a **block list**; blocks are 4 MB | O(block) patch, O(blocks) rehash | What Dropbox does. |

Recommendation: ship (a). `size` is on the row, so `stat` never reads bytes. Move to (c) later.
**(c) changes only what the `hash` string names. The seam in section 4 does not change.**

### 8.2 The native filesystem backend

It stops being an odd third case. Its bytes are the files on disk. Its rows are a sidecar
database. Reconciliation repairs drift after a crash or an outside edit. That is the same cost
as today's plan (phase 6), and it now uses the same store contract as every other backend.

The one thing it cannot do is join the sidecar and the disk in one transaction. That is a
property of POSIX, not of this design, and it is already documented as such.

### 8.3 Ordering during a pull

A pull page can contain a child before its parent, because `seq` is commit order, not creation
order. This is safe by section 3.3: the child is stored and stays invisible until its parent
arrives. But an invisible node whose parent later turns out to be ignored would mean ignored
metadata was stored locally. Fix: hold rows with an unresolved chain in a quarantine list, and
re-test them at the end of each pull round. The sender already filters correctly, because it can
see the whole chain, so the quarantine stays small.

### 8.4 Migration

`Ino` is already a UUID in the memory, IndexedDB and SQLite backends, so `id` can be the existing
`Ino`. The migration is one pass that joins each inode with its dirent and writes one row. The
first sync after the migration is a full re-read on both sides, which is the same work the
existing `SyncNodeId` backfill needs.

### 8.5 What this does not solve

- Recursive delete stays O(N). The earlier sync-node-identity design already accepts this.
- Publishing a subtree across a visibility boundary stays O(N).
- Two replicas that concurrently move A under B and B under A still need an authority to decide.
  The proposal makes the failure safe, not impossible.

---

## 9. Suggested order of work

Each step is shippable and testable on its own.

1. Write the `Store` and `Tx` contract, plus a conformance test suite against it.
2. Implement `memStore`. Port the existing `fs` tests to run through it.
3. Rewrite `volume.ts` to call the core functions in section 4.2. The public API does not change,
   so every existing consumer test is the regression suite.
4. Implement `sqliteStore` and `idbStore` against the same conformance suite.
5. Write the sync loop of section 4.4 with a server-authority `Merge`. Delete protocol v1 and
   protocol v2 together.
6. Add the ignore predicate. It should be one function and two call sites.
7. Move the native filesystem backend onto the sidecar model.

Step 6 is the test of whether this report is right. If the ignore list is not close to one
function and two call sites, the model is still wrong somewhere.
