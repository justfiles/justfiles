# Fable design: the minimal file-sync model

Response to [research.md](./research.md). Three deliverables: the access
patterns (#1), the minimal data structures (#2), the minimal implementation
seam (#3). Then a requirements check, a compression review, prior art, and
the comparisons with the two sibling designs.

Revised after reading two sibling designs from other agents:
[sol-design.md](./sol-design.md) and [opus-design.md](./opus-design.md). The
ideas taken and rejected from each are recorded in the comparison sections
near the end.

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
| cross a mount | resolution reaches a `mount` node and continues in the bound store | cross-store rename returns `EXDEV` |
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
| push delta | the same scan on the local store, filtered to rows this replica authored | the author tag lives inside `version` |
| apply remote batch | atomic multi-node write, with version guards | all-or-nothing; the cursor advances after the commit |
| detect echo / retry | author tag filters the push; version comparison absorbs retries | no origin tags anywhere |
| content transfer | `has` / `get` / `put` by hash | dedupe before upload; no upload on move |
| effective path of a node | walk `parent` links upward | pure reads; cacheable; needed for watch scoping and event paths |
| tombstones | deleted rows stay in the table and appear in the feed | no separate tombstone store |
| engine state (peer cursors) | `/private/state`, outside the replicated table | may only lag applied rows; expired state bootstraps into a fresh store |
| push conflict / authority accept | edit/edit is last-writer-wins; the authority enforces tree rules | a tree-rule rejection is a commit failure |

### C. Maintenance

| Operation | Access pattern | Notes |
| --- | --- | --- |
| blob GC | sweep stored hashes not referenced by any row | backend-internal; must not race commits |
| tombstone prune | delete rows older than the signed-cursor lifetime and advance the feed floor | bounded backend maintenance |
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
type Cursor = string   // Opaque, minted by the store whose feed it resumes.

type Node = {
	id: NodeId
	parent: NodeId
	name: string
	type: 'file' | 'dir' | 'symlink' | 'mount'  // mount: a junction to another store
	mode: number                       // full POSIX mode (S_IFMT bits + permissions)
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
- **Mount**: a junction node. It claims its name through the normal guard,
  syncs like any row, and can never have children, because only a directory
  can be a parent. Which store backs it is per-replica local configuration,
  like fstab. The mount *point* is shared data; the *binding* is local.
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
- per-path sync filters — local-only data is a separate mounted store, not a
  filtered path (see mounts below). The replicated table has no invisible
  regions.

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
   live nodes. `child` is the hot path and must be a point lookup. If a
   transient mid-sync state holds two live rows for one `(parent, name)`,
   resolution picks the lowest `id` — the same rule on every replica, so
   replicas agree on the visible winner even while converging (taken from
   opus-design). `children` returns its pages in one stable name order, so
   a resumed listing never skips or repeats an entry.
2. `commit` is atomic. All writes and all guards evaluate in one
   transaction. Any failed guard commits nothing.
3. Writes replace whole rows. There is no partial patch. Idempotent by
   content: committing a row the store already holds is a no-op.
4. `since` returns each node at most once per scan, at its latest committed
   position, tombstones included. An updated node moves to the end of the
   order, so a resumed cursor can see a node again with newer state, but can
   never permanently miss one. This makes the feed resumable, crash-safe,
   and self-compacting. No journal ever grows.
5. Node rows are replica-identical. A `Cursor` belongs to the store whose
   feed it resumes. A peer-facing cursor is a receiver-signed token; its
   encoding remains private to that receiver.
6. The root id is a fixed constant. `get(ROOT)` always returns a live
   directory.
7. Blobs are immutable. A local caller is trusted on `put(hash, data)`; a
   store that accepts writes from a peer must verify the hash.
8. `subscribe` is a latency optimization over polling `since`. `gc` must not
   race cursor validation plus the commit it authorizes.
9. Tree invariants (no cycles, no duplicate names, every parent a live
   directory) are enforced by the **authority's** commit via guards — not
   by every store.
   A replica may transiently hold detached or even cyclic rows mid-sync.
   That is safe because visibility is reachability from root: a detached or
   cyclic cluster is simply invisible until later rows reattach it. Upward
   walks bound themselves with a visited set.
10. Write ordering (taken from sol-design): a writer makes content durable
   (`blobs.put` resolved) before it commits a row that references the hash.
   A crash can then leave only an orphan blob — never a committed row whose
   bytes were lost. A row whose blob is absent by *choice* is a lazy stub
   (selective content), not corruption.
11. Lineage and bounded history: a `Cursor` is bound to the store's lineage.
   A peer-facing cursor also carries a receiver-owned expiry and feed
   position. A reset, expired cursor, or position below the retained feed
   floor requires read-only bootstrap into a fresh local store. It must not
   merge a current snapshot into stale rows, because a swept tombstone is
   now represented by absence.

### The two consumers, on top of the seam

**`volume(store): Volume`** — the POSIX adapter, written once. Every row of
table A maps to seam calls mechanically. Users and agents see only `Volume`;
a synced volume and a local volume are indistinguishable, like a Dropbox
folder. One POSIX behavior doubles as a concurrency guard (a gap
opus-design exposed): the volume stamps the parent directory's `mtime` on
every create, delete, and rename inside it — real filesystems do the same —
so every structural change bumps the parent row's version. A batch that
enumerated a directory (`rm -r`) guards the parent's version and cannot
race a concurrent create it did not see. A rename therefore touches three
rows (the moved node, both parents) — still independent of subtree size.

**`sync(local: Store, remote: Store)`** — the engine. Its whole loop:

```text
push: local.since(cursor)  → remote.commit(rows) → advance cursor
pull: remote.since(cursor) → local.commit(rows) → advance cursor
blobs: for each new content hash — has? skip : transfer (lazy where allowed)
```

The seam stays unchanged over a peer connection. A relationship-bound
remote `Store` adapter attaches the last receiver-issued cursor to each
wire operation; the receiver validates that token before it calls its raw
store. Local calls carry no token. HTTP uses a private header and in-process
P2P passes the same envelope directly — neither introduces a second
storage-shaped interface.

- **Idempotent**: same-version upserts make retries and echo loops
  harmless. No origin tags, no echo suppression machinery.
- **Push filter — no echo in the steady state** (sharpened by opus-design):
  `Version` carries its author replica id. Push sends only rows this
  replica authored since the push cursor, so pulled rows are never pushed
  back — idempotence is the safety net, not the steady state. opus-design
  exposed that "idempotent apply" alone would re-send every pulled row
  once; it solves this with a per-row `base` field, which we decline (see
  the comparison).
- **Resumable**: the cursor advances only after its batch commits. It may
  lag, never lead, so a crash costs a re-apply of rows that no-op.
- **Authoritative**: the server serializes accepted writes into its feed and
  refuses tree changes that break namespace rules. The engine settles those
  refusals locally, then replans.
- **Conflicts**: edit/edit is last-writer-wins. Tombstones and versions on
  the wire separate an edit from a delete, so the authority can reject a
  buried id and the engine can recreate the edited file. If the product later
  needs edit conflict copies or field-level merges, the engine keeps a base
  cache of last-synced rows and applies that policy per node. Engine module;
  zero seam change. See [`sync-conflict-policy.md`](sync-conflict-policy.md).
- **Composable**: client–server is a star of `sync(local, hub)` loops. P2P
  is `sync(a, b)` both ways. The seam does not know the topology; only the
  meaning of `Version` (single authority counter vs. version vector) changes,
  and `Version` is opaque to every store.
- **Engine state**: the two cursors live under `/private/state`, in the
  host's local mounted store and outside the replicated table. A cursor may
  only lag the rows it covers. A missing cursor starts read-only bootstrap;
  an expired or swept-behind cursor replaces the stale store from the
  winner selected by sync policy. Nothing engine-owned enters the shared
  namespace or its feed.

#### The namespace: local data without ignore rules

- **Local-only data — mounts, not ignore lists** (taken from sol-design,
  then hardened): data that must not sync lives in a separate store, joined
  to the tree by a `mount` node committed in the synced store. There is no
  path router and no prefix configuration. The volume is
  `volume(store, bindings?: Map<NodeId, Store>)`; path resolution switches
  stores when it walks through a mount node, the way a kernel crosses a
  vfsmount. The boundary is enforced by the data, not by policy code: the
  mount node claims its name through the ordinary `free` guard, so nothing
  else can occupy `/private`; and since only a directory can be a parent,
  the mount node can never have children — a `/private` subtree cannot
  exist in the synced store at all, on any replica, buggy or not. An
  unbound mount reads as an empty read-only directory. A rename that
  resolves across two stores returns `EXDEV`, as `rename(2)` does for every
  cross-device rename; the volume emulates copy-then-remove, like `mv`, but
  only for a move that is two commits and no more — one row, into a free
  name. A directory keeps the `EXDEV`: a subtree is a commit per row across
  two stores with no guard spanning them, so anything that stops it leaves
  half a subtree standing. So does a taken destination, since two commits
  give no moment where the name holds one or the other. And a mount point is
  no end of a rename at all — `EBUSY`, unbind it first, as `rm` already
  answers on the same row. A sync engine
  receives one store and nothing else, so no delta, tombstone, or blob
  request can even name local data. This deletes the projection filter, the
  visible↔ignored transition rules, the effective-list hashing, and the
  reconciliation flow of
  [sync-node-identity.md](../../tasks/sync-node-identity.md) — the whole
  PR-494 problem class. Creating or removing a mount is one ordinary
  guarded row write that syncs everywhere; who may commit mount rows is
  authority policy.
- **Private host state**: `/private/state/clientid` holds the install's
  stable peer id. `/private/state/sync.json` holds its changing relationship
  cursors. The id is also the version author and the input to a P2P winner
  selector, but its write-once file stays separate from the frequently
  written sync record. Both live behind the private mount; neither needs a
  path ignore rule.
- **Silent mounts — invisible local folders**: an announced mount reserves
  a name everywhere, but it also discloses that the name exists. When even
  the existence must stay private (`/.special`), the replica adds a
  *silent* binding: a view-layer overlay entry `(parentId, name) → store`,
  checked during resolution before the synced-row lookup. Nothing about it
  is ever written to the synced store, so no peer can learn of it. The
  classic conundrum — another client creates the same name and the server
  pushes it down — dissolves here: those rows land in the synced *table*
  and stay shadowed at read time, exactly like a kernel mount over a
  non-empty directory. Sync needs no special treatment, shadowed blobs are
  never fetched (selective content), and removing the binding reveals the
  shared data intact. The cost is deliberate, kernel-precedented
  divergence: this replica sees its local folder where others see the
  shared one. Rule of thumb: announce when disclosure is acceptable —
  collision becomes impossible; go silent when privacy demands it — and
  accept shadowing.
- **Per-replica file content**: a synced symlink whose target resolves into
  a local mount gives every replica its own bytes behind one shared path —
  the Unix `/etc` convention. This is the clean shape for `.env`-style
  secrets: the tree shape syncs; the content never does.
- **Ignored files (globs)**: no glob ignore exists in the core, and none is
  needed, because the real cases decompose. (1) OS and tool junk
  (`.DS_Store`, `*.swp`) appears only where a real directory exists, so it
  is an import filter private to the native bridge: the bridge never
  commits matching observations, and a list change needs no reconciliation
  because ignored files were never in any store. (2) Secrets by convention
  use the symlink-into-mount pattern above. (3) Regenerable trees
  (`node_modules`) are first simply tolerated — rows are tiny and content
  is lazy — and, if measurement ever demands more, become silent bindings
  applied by name convention: micro-mounts at the view layer with the same
  shadowing semantics. Patterns never enter the protocol, so the PR-494
  machinery stays deleted.
- **Selective content**: rows always sync; blobs fetch on demand. A replica
  that does not want the bytes never calls `blobs.get` — a lazy stub. This
  is a materialization choice, never an identity or visibility choice, so
  it needs no protocol support at all.
#### What falls out for free

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

## Requirements check

[research.md](./research.md) set three requirements. Where each one lands:

1. **"Expose fs APIs; plug into just-bash; implement in any tech; run
   anywhere."** `Volume` keeps its exact POSIX surface (table A), so agents
   and `just-bash` cannot tell it from a real filesystem. A backend is one
   table, two indexes, one ordering, and one blob map — implementable on
   memory, SQLite, IndexedDB, Postgres, or a native directory with a
   sidecar. Nothing in the seam names a platform.
2. **"Sync seamlessly; the user never knows; rock solid."** A synced volume
   is `volume(store)` with an engine running beside it — the same surface,
   the Dropbox-folder experience. "Rock solid" comes from small guarantees
   that compose: atomic guarded commits, an idempotent self-compacting
   feed, blob-before-row ordering, lineage-fenced cursors,
   invisible-until-reachable application, and one convergence target —
   replica-identical rows.
3. **"Composable sync: P2P and central authority."** The engine connects
   any two `Store`s. Topology is a policy choice — the meaning of `Version`
   and the conflict rule — never a structural one. Central authority ships
   first; P2P changes engine policy modules and no row, seam, or wire
   shape.

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
| origin / observed / MutationOptions | yes | author-tagged versions filter the push; idempotence absorbs the rest |
| ino↔nodeId mapping | yes | there is only one identity |
| capability matrix (4 strategies) | yes | one required contract |
| parent-before-child wire ordering | yes | invisible-until-reachable replaces it |
| `size` on the row | no — stat must not fetch content | keep |
| `ctime`, `uid`, `gid` | yes | dropped |
| ignore projection module | yes | replaced by mounts — local data is a separate mounted store |
| engine-state system subtree | yes | relationship state moved into the separate private mount |

Final form: **one table, two lookups, one order, one guarded atomic write,
one hash-keyed blob map. The same seam is the storage API and the wire.**
Mounts are the only composition mechanism: whole stores, joined at a node.
Nothing else survived.

### What stays hard — and where it lives

The design contains complexity; it does not delete it. But each hard part is
now a pure module behind the seam, not a seam:

- Mount crossing — path resolution switches stores at a mount node or a
  silent binding; a small, contained piece of `volume()`. The price of
  deleting the projection machinery is `EXDEV` at mount boundaries and
  kernel-style shadowing under silent mounts, which UX must explain.
- Conflict policy (last-writer-wins for edits, settle tree-rule refusals) —
  engine module. Detecting edit conflicts later needs a base cache.
- Tombstone retention — a receiver signs expiring cursors, retains tombstones
  for at least that cursor lifetime, and rejects positions below its swept
  feed floor. The policy and collector stay behind the seam.
- Native FS reconciliation — one adapter's private problem.
- Blob GC vs. in-flight commits — one backend method's private problem.

The test for the future: a PR-494-sized feature must change engine modules
and zero seam signatures. If a feature demands a new seam member, the design
review starts with "why can this not be rows?"

### Future expansion is additive

The proof of the shape is what happens to the next ten features. Each lands
in exactly one place; none changes a seam signature or the meaning of a
stored fact:

| Future feature | Where it lands | What changes |
| --- | --- | --- |
| large files | `content` names a chunk manifest | blob encoding only |
| block-level / delta transfer | `blobs` implementation | backend optimization |
| P2P topology | `Version` meaning + merge policy | engine modules |
| field-level three-way merge | base cache in the engine | engine module |
| search index, backup, audit trail | new subscribers of `since` | nothing — the feed is already the integration point |
| a new backend (Postgres, R2, …) | one `Store` implementation | the conformance suite proves it |
| signed rows for untrusted peers | an optional signature field on the row | additive field; verification in the engine |
| tombstone pruning | signed cursor horizon + bounded maintenance walk | backend policy behind `gc` |
| `uid`/`gid`, ACLs, birth time | optional row fields or xattrs, when a product need defines them | additive fields |

One risk on this list is legitimately structural, and the kill criterion at
the end of this document names it: IndexedDB atomicity for guarded batch
commits. Everything else has a place already waiting for it.

---

## Prior art: taken and rejected

- **Dropbox Nucleus** — taken: stable node identity, location as
  `(parent, name)`, O(1) moves. Rejected: the three-tree
  (Local/Remote/Synced) planner; a serializing authority plus idempotent
  row apply is enough for our topology, and the task doc already declared
  the planner a non-goal.
- **CouchDB/PouchDB replication** — taken almost whole: the changes feed as
  an index (not a journal), idempotent apply, checkpoints,
  resumability, any-topology composition. This is the backbone of the sync
  loop. Adapted: we add tree guards at the authority because we have a
  namespace and CouchDB does not.
- **Unison** — taken: the proof that two current trees cannot distinguish a
  create from a delete; a common base is required. Tombstones distinguish the
  edit/delete case. A base *cache* appears if edit conflict copies or
  three-way field merges become a product need.
- **Google Drive / Microsoft Graph delta APIs** — taken as confirmation:
  their delta feeds return full item state, not diffs, tombstones included
  — the industrial file-sync precedent closest to contract rule 4.
  (opus-design cites them for the same reason.)
- **Perkeep (permanodes)** — taken: one stable id per logical object,
  minted by its creator, never reused, independent of its content.
- **git / IPFS** — taken: content addressing, dedupe, "a move uploads
  nothing". Rejected: whole-tree Merkle snapshots as the sync unit; agents
  need per-file incremental sync, not commits.
- **Syncthing** — reserved: per-node version vectors as the P2P meaning of
  `Version`. The seam already permits it because `Version` is opaque.
- **Kleppmann's replicated tree move** — reserved: the concurrent-move CRDT
  if we ever drop the central authority. Engine-only change.

## Comparison with sol-design.md

Both designs reached the same first principles independently, which is good
evidence for them: stable node identity; `(parent, name)` as location; paths
as derived data; content-addressed bytes; delete-then-create mints a new id;
two indexes over one logical node set; "the sync model is the filesystem,
POSIX is a view"; engine state out of the user tree; O(1) moves by
construction.

**Taken from sol-design** (folded in above):

- Mounts instead of ignore lists — its best idea. It deletes our hardest
  engine module instead of containing it. We harden it one step: sol
  reserves mount paths by out-of-band product configuration; we make the
  mount point a node in the shared tree, so the name claim and the
  empty-subtree invariant come from the existing guards and parent rules,
  and only the store binding stays local. Both flavors survive: an
  announced mount node when reservation matters, and sol's configuration
  style as a silent binding when even existence must stay private.
- Lineage fencing after a reset (contract rule 11) — a gap in our draft.
- The blob-durable-before-row rule (contract rule 10) — our "lazy stub"
  wording could have hidden local data loss.
- Engine state strictly outside the user namespace — our "system subtree"
  was a mistake: it reintroduced a mini-ignore filter for our own rows.
- The Unison base argument, now answered explicitly by tombstones and
  versions in the feed.
- Its experiment discipline: prove the model in a small isolated package,
  with named kill criteria, before any migration.

**Rejected, with reasons:**

- *Whole-tree immutable snapshots published by one head CAS.* Every write —
  a `chmod`, one appended line — rewrites O(log N) Merkle-map blocks and
  contends on one global reference. Writers serialize through replay loops;
  the object store churns garbage at write rate; GC must trace reachability
  from every ref. sol-design itself names write amplification and head
  contention as its kill criteria. Our commit writes only the rows it
  touches, and guarded volume writes contend per node, not per tree — neither
  risk exists.
- *The four-method seam.* It is smaller than ours because a storage engine
  moved into shared core: canonical encoding, hashing, a hand-rolled
  persistent ordered Merkle map, structural diff. That map re-implements, on
  top of a dumb KV, the b-tree that SQLite and IndexedDB already have — and
  every path lookup then pays block decode and cache walks. Our eight
  methods let the backend's native index do its job. The smallest interface
  is not the smallest system.
- *Three-way state merge as the sync core.* Strictly more powerful for
  symmetric merge, but it needs snapshot retention, a base ref per peer, and
  graph-walking transfer negotiation ("which objects are you missing?") that
  is chatty over HTTP. One paged `since` feed with idempotent apply does
  central-authority sync in one round trip per page. Three-way rules stay
  available as a future engine module over a base cache.
- *Snapshot-consistent reads* (stable scans, stat from one immutable
  snapshot). Real POSIX gives no such guarantee, agents do not ask for it,
  and sync does not need it (contract rule 4 covers concurrent writers). We
  do not pay for a guarantee no consumer uses.

**Equivalences worth naming:** their `compareAndSwapRef` is our `Guard` —
the same atomicity, placed per node instead of per tree, which is why we
have no global contention point. Their refs are our cursor plus guards.
Their "wake, then diff" watch is our optional `subscribe` over `since`.
Their content-addressed everything buys whole-tree verification and cheap
history; we verify blobs only and trust the authority for rows — the right
trade for a live filesystem, revisitable if P2P ever needs signed rows.

## Comparison with opus-design.md

[opus-design.md](./opus-design.md) converged, independently, on nearly the
same core as this design: one row type, path derived from the parent chain,
a `seq` column as the change feed, `since(0)` as the snapshot, blobs by
hash, POSIX as a view, sync as an idempotent loop. Where sol-design took
the git road, opus-design and this design took the same road. Three
independent designs, two arriving at one model, is strong evidence for it.
The remaining differences are small and instructive.

Its diagnosis (§1) is the best-evidenced statement of the disease across
all three documents: three identities for one object, three shapes for one
change, three shapes for one state, and a measured 60-method backend
surface — with file-and-line receipts. Read it as the canonical "why".

**Taken from opus-design** (folded in above):

- The deterministic duplicate-name rule — lowest `id` wins, so all replicas
  agree on the visible winner even mid-convergence (contract rule 1).
- The push-filter problem. opus exposed that "idempotent apply" alone
  re-sends every pulled row once; the steady state must not lean on the
  safety net. We answer with author-tagged versions rather than its `base`
  field (see rejections).
- The enumerate-then-delete race. Its `tx` closure closes it structurally;
  our guarded batch needed the POSIX dir-`mtime` rule to close the same
  race. The gap was real.
- The migration observation that every syncing backend already mints `Ino`
  as a UUID, so `id` can be the existing ino. Verified against the code.
- Prior-art citations: Drive/Graph delta feeds as the industrial precedent
  for full-state rows with tombstones; Perkeep permanodes for
  creator-minted ids.

**Rejected, with reasons:**

- *`base` and `seq` inside the replicated row.* `base` is per-peer state
  ("what one peer confirmed") and `seq` is local commit order. Placing them
  in `Node` breaks the invariant that converged replicas hold identical
  rows, makes "the row is the wire shape" quietly false — both fields must
  be stripped before sending — and hard-codes a single peer: a second peer
  needs a second `base`. Per-replica state stays outside the row.
- *Ignore as a `Project` predicate.* opus keeps path-pattern visibility and
  inherits the whole class: a visible→ignored move must push tombstones for
  data that still exists locally, a policy change is an O(N) re-read of
  both sides, and pulled rows with unresolved parent chains need a
  quarantine list (its §8.3) precisely because an ignored ancestor may
  arrive later. Mounts delete the predicate, the quarantine, and the lying
  tombstones in one move: nothing ignored can exist in the synced store at
  all.
- *The `tx(fn)` closure seam.* Strictly more expressive than
  `commit(writes, guards)` — and exactly the shape IndexedDB punishes: any
  `await` of non-IDB work inside the closure auto-commits the transaction.
  Precomputed writes plus guards is the IDB-safe projection of the same
  atomicity. The closure also costs the wire symmetry: opus needs a
  separate `Peer` interface because a network hop cannot hold a `tx` open,
  while our `Store` *is* the wire.
- *No lineage fencing, no stated home for cursors.* A replaced server store
  silently invalidates every cursor; opus does not address it (contract
  rule 11 here, taken from sol-design), and its push/pull cursors have no
  named durable location.

**Equivalences worth naming:** its ten methods are our eight plus blobs;
its blob-before-row order (§4.3) is our contract rule 10; its
swap-the-`Merge` topology table is our opaque `Version`; its `watch(seq)`
and our `subscribe(rows)` are the same optional wake, dressed differently;
its "a row that breaks an invariant is invisible, not corrupt" (§3.3) is
our contract rule 9.

## Relation to the current code

- `Volume` survives with its exact surface. No consumer notices anything.
- Wire protocol v2 (`NodeMutation`) is already row-shaped; it collapses into
  "a page of `Node` rows plus guards". The phase 1–3 work was the discovery
  of this model; this design is its closure.
- The migration path is the same seed-from-production runner that exists
  today: build `memStore` + conformance suite first, then SQLite, then point
  `volume()` at it, then retire the twin vocabulary.
- Every syncing backend already mints `Ino` with `crypto.randomUUID()`
  (verified: `storage.mem.ts:64`, `storage.idb.ts:405`), so `id` can simply
  *be* the existing ino — the data migration is one pass that joins each
  inode with its dirent and writes one row (taken from opus-design).
  **Corrected in T16:** the ino is per-replica, not shared. A node arriving
  from a peer is given a FRESH local ino (`applyMutation` in `sync/node.ts`
  calls `port.mintIno()`), so the shared identity is the SYNC id and that is
  what `id` must be; the ino stands in only where a node has no sync row. The
  pass is otherwise exactly this one — the join is what it always was.
- First proof lives in one small isolated package. It must show: a rename of
  a directory with 4,000 children is one row in the feed; a crash between
  `blobs.put` and `commit` leaves only an orphan blob; a deleted cursor
  re-applies a page into pure no-ops; a foreign-lineage cursor is rejected
  and bootstrap from the empty cursor converges. Kill criterion: if guarded
  batch commits cannot be made atomic on IndexedDB within its transaction
  lifetime rules, the seam — not the engine — must change, and this design
  is wrong.
