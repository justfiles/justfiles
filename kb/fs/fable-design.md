# Fable design: the minimal file-sync model

Response to [research.md](./research.md). Three deliverables: the access
patterns (#1), the minimal data structures (#2), the minimal implementation
seam (#3). Then a compression review and prior art.

## Diagnosis, in one paragraph

The current system keeps two models of the same data. `packages/fs` speaks
disk-FS: `Ino`, dirent store, `InodeMeta`, blob-per-inode. `packages/sync`
speaks sync: `SyncNodeId`, `parentId + name`, revisions, journals. Neither
model can see the other, so every feature pays a translation tax: an
ino↔nodeId mapping, mutation observers that convert one vocabulary into the
other, journal stores, snapshot sessions, a 4-row capability matrix, and
"parents before children" wire ordering. PR #494 (+3,555 lines for one ignore
list) is the tax bill. The fix is not a better adapter. The fix is one model.
The sync model **is** the filesystem. POSIX becomes a view.

---

## #1 — Access patterns

Three consumers touch the data: the POSIX surface (agents, just-bash), the
sync engine, and maintenance. The tables list every access, reduced to its
data pattern.

### A. POSIX surface (via `Volume`)

| Operation | Access pattern | Notes |
| --- | --- | --- |
| resolve path | point lookup `(parent, name)` per segment | hottest read; must be indexed and cacheable |
| `stat` / `lstat` / `exists` | point lookup by id | needs `size` without touching content |
| `readdir` | ordered scan of children of one node | paged |
| `readFile` | point lookup by id, then content fetch by hash | large value read |
| read range | content fetch, sliced | backend may optimize later; not a seam requirement |
| `writeFile` | store content bytes, then atomic node write | create needs "name is free" exclusivity |
| `appendFile` / truncate | read content, modify, store, atomic node write | read-modify-write at the view layer |
| `mkdir` | atomic node write with "name is free" guard | |
| `rename` | atomic write of ONE node (new parent, name), plus tombstone of a displaced node | O(1) for any subtree size, by construction |
| `rm -r` | atomic batch write of tombstones | O(subtree); enumerate via children scans |
| `cp -r` | children scans + content reuse by hash + node writes | no byte copy; hash reuse |
| `chmod` / `utimes` | atomic single-node write | whole-row replace |
| xattr get/set/list/remove | fields inside the node row | no separate store |
| `symlink` / `readlink` | inline field on the node row | no content fetch |
| `scan` | full tree walk via children scans | |
| `watch` | push feed of committed node rows, or poll "changes since" | events synthesized by row diff |

### B. Sync engine

These are the accesses a real disk FS cannot serve well. This is the
"superset" part.

| Operation | Access pattern | Notes |
| --- | --- | --- |
| pull delta | ordered scan "all node rows changed since cursor" | paged, resumable |
| bootstrap | the same scan, from the empty cursor | no separate snapshot mechanism |
| push delta | the same scan on the local store, filtered by projection | |
| apply remote batch | atomic multi-node write, with version guards, plus cursor row in the same write | all-or-nothing |
| detect echo / retry | version comparison on the row | idempotent apply replaces origin tags |
| content transfer | `has` / `get` / `put` by hash | dedupe before upload; no upload on move |
| effective path of a node | walk `parent` links upward | pure reads; cacheable; needed by ignore filter |
| tombstones | deleted rows stay in the table and appear in the feed | no separate tombstone store |
| engine state (cursors, policy hash) | ordinary node rows under a reserved system subtree | atomic with applied batches for free; never enters a feed |
| conflict detect / authority accept | version guard + name-free guard at commit | rejection is a commit failure |

### C. Maintenance

| Operation | Access pattern | Notes |
| --- | --- | --- |
| blob GC | sweep stored hashes not referenced by any row | backend-internal; must not race commits |
| tombstone prune | delete rows below a horizon all peers passed | optional, later |
| backup / export | changes-since scan from empty cursor | same primitive as bootstrap |

**Summary.** The superset beyond POSIX is exactly five things: lookup by
stable id, ordered changes-since scan, hash-addressed content, atomic
guarded multi-row write, and tombstones. Everything else is plain POSIX.

---

## #2 — Minimal data structures

One replicated row type, one content map, one per-replica ordering. Nothing
else is stored.

```ts
type NodeId = string   // UUID. Minted once, never rebound. Root is a well-known constant.
type Hash = string     // SHA-256 of content bytes, hex.
type Version = string  // Opaque to storage. The engine owns its meaning.
type Cursor = string   // Opaque, per replica. Never crosses the wire.

type Node = {
	id: NodeId
	parent: NodeId
	name: string
	type: 'file' | 'dir' | 'symlink'
	mode: number
	mtimeNs: bigint
	size: bigint                       // denormalized so stat never touches content
	xattrs?: Record<string, Uint8Array> // small values only; big data belongs in content
	content?: Hash                     // files only
	link?: string                      // symlinks only, inline
	version: Version
	deleted?: true                     // tombstone: only id, version, deleted stay meaningful
}
```

- **Content**: immutable bytes keyed by `Hash`. A move or copy never moves
  bytes. A missing blob for a referenced hash is a lazy stub; an orphan blob
  is garbage.
- **Order**: each committed write gets a position in the replica's local
  order. This is storage-assigned, local, and invisible to peers.

### What is derived, not stored

- **Paths** — walk `(parent, name)` down from root, or `parent` links up.
- **The directory tree** — it is the `(parent, name)` index.
- **The change journal** — it is the local order index. No journal rows.
- **Snapshots** — a changes-since scan from the empty cursor.
- **Watch events** — row diffs from the commit feed.

### The convergence invariant

Converged replicas hold **identical node rows and identical blobs**. Only
the local order and cursors differ per replica. Sync is: make the row sets
equal. Nothing more.

### Deliberate omissions

- `ctime` — report `mtime`. No consumer needs the distinction.
- `uid` / `gid` — out of scope; xattrs if ever needed.
- hard links — one `(parent, name)` per id stays the rule.
- range-write as a primitive — the view layer does read-modify-write. If big
  files ever matter, `content` becomes a manifest hash (list of chunk
  hashes). The seam does not change.

---

## #3 — The seam

One interface. It is both the storage seam **and** the wire: a remote peer is
just another `Store`. Five required node operations, three content
operations, two optional extras.

```ts
type Page = { nodes: Node[]; next?: Cursor }

type Guard =
	| { free: { parent: NodeId; name: string } }      // no live node holds this (parent, name)
	| { version: { id: NodeId; is: Version | null } } // CAS; null means "must not exist"

interface Store {
	// The two indexes on the one table.
	get(id: NodeId): Promise<Node | null>
	child(parent: NodeId, name: string): Promise<Node | null>
	children(parent: NodeId, cursor?: Cursor): Promise<Page>

	// The one ordering.
	since(cursor?: Cursor): Promise<Page>

	// The one write.
	commit(writes: Node[], guards?: Guard[]): Promise<void>

	// The one content map.
	blobs: {
		has(hash: Hash): Promise<boolean>
		get(hash: Hash): Promise<Uint8Array | null>
		put(hash: Hash, data: Uint8Array): Promise<void>
	}

	// Optional. Everything works without these.
	subscribe?(listener: (writes: Node[]) => void): () => void
	gc?(): Promise<{ reclaimed: number; done: boolean }>
}
```

### Contract

1. One logical table, two lookups: by `id`, and by `(parent, name)` over
   live nodes. `child` is the hot path and must be a point lookup.
2. `commit` is atomic. All writes and all guards evaluate in one
   transaction. Any failed guard commits nothing.
3. Writes replace whole rows. There is no partial patch. Idempotent by
   content: committing a row the store already holds is a no-op.
4. `since` returns each node at most once per scan, at its latest committed
   position, tombstones included. An updated node moves to the end of the
   order, so a resumed cursor can see a node again with newer state, but can
   never permanently miss one. This makes the feed resumable, crash-safe,
   and self-compacting. No journal ever grows.
5. Node rows are replica-identical. `Cursor` is replica-private.
6. The root id is a fixed constant. `get(ROOT)` always returns a live
   directory.
7. Blobs are immutable. A local caller is trusted on `put(hash, data)`; a
   store that accepts writes from a peer must verify the hash.
8. `subscribe` is a latency optimization over polling `since`. `gc` must not
   race an open commit.
9. Tree invariants (no cycles, no duplicate names, live parents) are
   enforced by the **authority's** commit via guards — not by every store.
   A replica may transiently hold detached or even cyclic rows mid-sync.
   That is safe because visibility is reachability from root: a detached or
   cyclic cluster is simply invisible until later rows reattach it. Upward
   walks bound themselves with a visited set.

### The two consumers, on top of the seam

**`volume(store): Volume`** — the POSIX adapter, written once. Every row of
table A maps to seam calls mechanically. Users and agents see only `Volume`;
a synced volume and a local volume are indistinguishable, like a Dropbox
folder.

**`sync(local: Store, remote: Store)`** — the engine. Its whole loop:

```text
pull: remote.since(cursor) → project → local.commit(rows + cursor-row)
push: local.since(cursor)  → project → remote.commit(rows, guards)
blobs: for each new content hash — has? skip : transfer
```

- **Idempotent**: version-guarded upserts make retries and echo loops
  harmless. No origin tags, no echo suppression machinery.
- **Resumable**: the cursor row commits atomically with the applied batch.
- **Authoritative**: the server is a `Store` whose `commit` enforces the
  guards plus tree invariants and serializes accepted writes into its feed.
  A rejection is a failed commit; the engine pulls and replans.
- **Composable**: client–server is a star of `sync(local, hub)` loops. P2P
  is `sync(a, b)` both ways. The seam does not know the topology; only the
  meaning of `Version` (single authority counter vs. version vector) changes,
  and `Version` is opaque to every store.
- **Projection (ignore lists)**: a pure filter between `since` and `commit`.
  It computes effective paths by parent walks with a cache. All the
  visible↔ignored transition rules from
  [sync-node-identity.md](../../tasks/sync-node-identity.md) live inside this
  one engine module. The seam gains **zero** methods for it. Engine state
  (effective list hash, reconcile cursor) is system node rows.
- **O(1) move**: a rename writes one row, which occupies one feed position,
  which is one wire row, which is one commit on each replica. The 4,000-file
  rename that motivated the node-identity epic costs the same as touching
  one file — by construction, not by optimization.
- **Bootstrap**: `since(ø)`. No snapshot sessions, no handoff protocol.
  Contract rule 4 makes a concurrent writer harmless: any row it changes
  reappears later in the scan.

### Backends

| Backend | Table + order | Blobs | Notes |
| --- | --- | --- | --- |
| memory | two maps + array | map | reference and conformance suite |
| SQLite | one table, three indexes (id, parent+name, seq) | one table | server and durable hosts; guards in the same transaction |
| IndexedDB | one object store, two indexes | one store | browser |
| native FS | real files + sidecar index | the files themselves | `since` = reconcile scan against sidecar; documented weaker crash model |

The conformance suite runs the same behavior tests against every backend.
There is no capability negotiation: the contract is the contract.

---

## Review: compress until nothing can move

Attempt to remove every member. Result of each attempt:

| Member | Removable? | Verdict |
| --- | --- | --- |
| `get` | no — sync addresses by id; parent walks need it | keep |
| `child` | no — path resolution is the hottest operation | keep |
| `children` | no — it IS the directory listing | keep |
| `since` | no — it IS sync, watch, scan, bootstrap, backup | keep |
| `commit` | no — it IS every write | keep |
| guards | only by giving up "rock solid" under concurrency | keep; there are exactly two kinds |
| `blobs.has` | yes, but it buys dedupe-before-upload for one method | keep |
| `blobs.get/put` | no — content must move separately from rows | keep |
| `subscribe` | yes — poll `since` | demoted to optional |
| `gc` | yes — maintenance | demoted to optional |
| separate xattr ops (4 methods today) | yes | folded into the row |
| separate journal store | yes | folded into the order index |
| snapshot sessions | yes | folded into `since(ø)` |
| origin / observed / MutationOptions | yes | idempotence replaces echo suppression |
| ino↔nodeId mapping | yes | there is only one identity |
| capability matrix (4 strategies) | yes | one required contract |
| parent-before-child wire ordering | yes | invisible-until-reachable replaces it |
| `size` on the row | no — stat must not fetch content | keep |
| `ctime`, `uid`, `gid` | yes | dropped |

Final form: **one table, two lookups, one order, one guarded atomic write,
one hash-keyed blob map. The same seam is the storage API and the wire.**
Nothing else survived.

### What stays hard — and where it lives

The design contains complexity; it does not delete it. But each hard part is
now a pure module behind the seam, not a seam:

- Ignore projection transitions (publish/unpublish subtrees) — engine module,
  pure function of the row set plus the list.
- Conflict policy (reject-and-replan first; merge later) — engine module,
  pure function of two versions.
- Native FS reconciliation — one adapter's private problem.
- Blob GC vs. in-flight commits — one backend method's private problem.

The test for the future: a PR-494-sized feature must change engine modules
and zero seam signatures. If a feature demands a new seam member, the design
review starts with "why can this not be rows?"

---

## Prior art: taken and rejected

- **Dropbox Nucleus** — taken: stable node identity, location as
  `(parent, name)`, O(1) moves. Rejected: the three-tree
  (Local/Remote/Synced) planner; a serializing authority plus idempotent
  row apply is enough for our topology, and the task doc already declared
  the planner a non-goal.
- **CouchDB/PouchDB replication** — taken almost whole: the changes feed as
  an index (not a journal), idempotent revision-guarded apply, checkpoints,
  resumability, any-topology composition. This is the backbone of the sync
  loop. Adapted: we add tree guards at the authority because we have a
  namespace and CouchDB does not.
- **git / IPFS** — taken: content addressing, dedupe, "a move uploads
  nothing". Rejected: whole-tree Merkle snapshots as the sync unit; agents
  need per-file incremental sync, not commits.
- **Syncthing** — reserved: per-node version vectors as the P2P meaning of
  `Version`. The seam already permits it because `Version` is opaque.
- **Kleppmann's replicated tree move** — reserved: the concurrent-move CRDT
  if we ever drop the central authority. Engine-only change.

## Relation to the current code

- `Volume` survives with its exact surface. No consumer notices anything.
- Wire protocol v2 (`NodeMutation`) is already row-shaped; it collapses into
  "a page of `Node` rows plus guards". The phase 1–3 work was the discovery
  of this model; this design is its closure.
- The migration path is the same seed-from-production runner that exists
  today: build `memStore` + conformance suite first, then SQLite, then point
  `volume()` at it, then retire the twin vocabulary.
