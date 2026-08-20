# Sync-first file system architecture

Status: first architecture draft, 2026-08-15

## Recommendation

Make a versioned repository the source of truth. Build the POSIX-like file API on top of it.
Do not make sync an optional extension of a mutable inode store.

Use these rules:

1. A node ID is the identity of a file or directory.
2. A parent ID and a name are the location of a node. A path is derived data.
3. A content hash is the identity of file bytes.
4. A commit is one complete, immutable tree state.
5. One compare-and-swap of a head reference publishes a commit.
6. Sync compares three complete states: local, remote, and last synced.
7. Data that must not sync is a separate mounted repository. It is not an ignore rule.

This design keeps file system behavior in shared code. It also keeps sync state in the same
model as file state. A storage adapter has four required operations.

```ts
interface BlockStore {
	get(id: ObjectId): Promise<Uint8Array | null>
	put(id: ObjectId, data: Uint8Array): Promise<void>
	readRef(name: string): Promise<ObjectId | null>
	compareAndSwapRef(
		name: string,
		expected: ObjectId | null,
		next: ObjectId | null
	): Promise<boolean>
}
```

This is the smallest design found that supports atomic writes, efficient moves, stable
snapshots, retry, deduplicated content, offline work, and more than one storage technology.

## Why the current seam grows

The current `Storage` interface is small. Sync cannot use it as its complete state model, so
sync adds a second mutable model beside it:

- local inode to sync-node mapping;
- node state and per-node revisions;
- an ordered journal and cursor;
- mutation observation inside the file system transaction;
- snapshot sessions and retained content;
- path and node protocols during migration;
- ignore-policy subscriptions and projection reconciliation;
- different recovery rules for memory, SQLite, IndexedDB, and native files.

Each feature must keep the file tree and the sync model consistent. This is the main source
of the large seam. The inode model is not the only problem. The more important problem is
that the system has two sources of truth.

[PR 494](https://github.com/xiaoxinghu/justfiles/pull/494) is useful evidence. The current
version changes 35 files and adds 3,555 lines while it adds one generic ignore policy. The
change must cover storage, snapshots, deltas, HTTP subscriptions, cursor fencing, resets,
node moves, scan fallback, tests, and product hosts. This is not only an implementation-size
problem. It shows that an ignore rule changes the identity and history model.

## Required invariants

These invariants define the design. An implementation that cannot keep them must use a
weaker, explicit adapter such as the native working-tree bridge.

1. Every live non-root node has one live parent and one name.
2. A directory contains no two live children with the same name.
3. A node ID does not change after a move or content edit.
4. A delete followed by a create at the same location gets a new node ID.
5. A regular file always refers to complete, verified content.
6. A published head always names one complete and valid snapshot.
7. A failed write can leave unused immutable objects, but it cannot expose a partial tree.
8. A retry of the same commit has the same result.
9. A directory cannot be its own ancestor.
10. A local or system-only namespace cannot be reached from a synchronized repository.
11. A reset creates a new lineage. A stale sync base cannot cross that lineage.

## 1. Access patterns

Let:

- `D` be path depth;
- `N` be the number of nodes in a tree;
- `K` be the number of entries in one directory;
- `C` be the number of nodes that changed;
- `B` be the number of content blocks read or written.

The table describes logical access. A persistent map can add a logarithmic factor to key
lookups. A cache can remove repeated block reads. These factors do not change the required
shape of the data.

| Use | Main key | Required result | Consistency | Cost target |
| --- | --- | --- | --- | --- |
| Resolve a path | `(parentId, name)` for each part | Stable node ID and node | One snapshot for the complete walk | `O(D)` lookups |
| `stat` or `lstat` | node ID | Type, size, mode, times, and content hash | One snapshot | `O(1)` logical lookup |
| Test existence | `(parentId, name)` | Present or absent | One snapshot | `O(D)` path walk |
| List a directory | parent node ID | Children ordered by name | Stable page from one snapshot | `O(K)` output, keyset pages |
| Read a file | content hash | Verified immutable bytes | Bytes must match the node snapshot | `O(B)` |
| Read a byte range | content hash and range | Verified blocks that cover the range | Same file version for all blocks | `O(B)` |
| Create a file | parent ID and name | New node, metadata, and complete content | Name claim and bytes publish together | One head change |
| Overwrite a file | node ID | Same node ID with new content and metadata | Old or new snapshot, never a partial blob | One head change |
| Append or range-write | node ID and expected head | New complete content object | Serialize edits to the same node | Read changed blocks, one head change |
| Change mode, time, or xattrs | node ID | New node value | Atomic with the head change | One head change |
| Create a directory or symlink | parent ID and name | New typed node | Atomic name claim | One head change |
| Move or rename | node ID, old location, new location | Same node at the new location | Source removal and destination claim are one fact | Independent of subtree size |
| Replace on move | destination location | Removed destination and moved source | One head change | Independent of moved subtree size |
| Copy a file | source node and destination | New node ID that can share immutable content | Destination appears complete | `O(1)` content copy |
| Copy a directory | source subtree and destination | New IDs for the copied tree | No partial published copy | `O(N)` in copied subtree |
| Remove a file | location and node ID | Node absent from the new state | One head change | `O(1)` logical change |
| Remove a directory tree | root node ID | Complete subtree absent | No partial published delete | `O(N)` is acceptable initially |
| Walk or scan a tree | root node ID | Parent-before-child nodes and derived paths | One immutable snapshot | `O(N)` output |
| Watch | head reference | Wake signal that the head changed | A wake is not a durable log | `O(1)` notification |
| Detect native disk edits | path, file ID, mtime, size | A new observed local snapshot | Re-scan repairs missed events | Proportional to candidates, full scan fallback |
| Start sync | local, remote, and synced commit IDs | Three valid snapshots | Each snapshot is immutable | `O(1)` roots, then changed blocks |
| Find incremental changes | two snapshot roots | Changed node IDs and locations | Diff complete states | `O(C)` map diff target |
| Detect a move | same node ID in two states | Old and new parent/name | Identity is not path | `O(1)` per changed node |
| Merge concurrent work | base, local, and remote node values | Merged node or explicit conflict | Deterministic three-way rules | `O(C)` target |
| Transfer content | content hash | Missing verified blocks only | Hash verification before publish | `O(B)` missing data |
| Retry after a lost response | proposed commit ID and expected head | Accepted, already accepted, or stale | Idempotent | No new logical work |
| Recover after a crash | durable refs and immutable objects | Last complete head | Ignore unreferenced objects | `O(1)` root recovery |
| Reset or replace a repository | lineage ID and head | New history that rejects old sync bases | One atomic head change | `O(1)` root change |
| Garbage collection | all live refs | Remove unreachable objects | Never remove a reachable object | `O(objects)` maintenance |
| Keep data local only | mount path | Route access to a local repository | No shared object can name it | No sync work |

### Important access-pattern conclusions

- Path lookup and node lookup are both first-class. The state needs a node-ID map and a
  `(parentId, name)` index.
- A path must not be stored as identity. A move changes one node location and two index
  entries. It does not change descendants.
- Snapshot reads are more important than inode-like partial updates. Sync, scan, and retry
  all need a stable state boundary.
- Content reads and tree metadata reads have different keys and different retention needs.
  Keep them separate.
- A wake mechanism is sufficient for `watch`. A durable journal is not required when the
  old and new immutable states can be compared.
- A common base is required. Two current trees cannot distinguish a create on one replica
  from a delete on the other replica.

## 2. Minimal logical data

The logical model has three user-data objects: node, snapshot, and commit. File bytes are
immutable blocks. Persistent-map blocks are an encoding detail owned by shared core code.

### Node

```ts
type NodeId = string
type ObjectId = string // hash of canonical object bytes

type PortableMeta = {
	mode: number
	mtimeNs: bigint
	xattrs: ReadonlyMap<string, Uint8Array>
}

type Node = {
	id: NodeId
	parentId: NodeId | null
	name: string
	meta: PortableMeta
	payload:
		| { type: 'file'; size: bigint; content: ObjectId }
		| { type: 'directory' }
		| { type: 'symlink'; target: string }
}
```

The root has `parentId: null` and `name: ''`.

The node does not contain these fields:

- `path`: derive it by following parent IDs;
- `localIno`: this belongs only to a native materializer;
- `revision`: the commit is the version boundary;
- `deleted`: absence from a snapshot is deletion;
- file bytes: the content object stores them;
- `ctimeNs`: this is local change time and is set when a snapshot is materialized;
- sync-engine xattrs: engine state is outside the user tree.

Only portable user xattrs belong in `PortableMeta`. A local adapter can expose more local
metadata, but it must not silently add it to shared state. Add `uid`, `gid`, ACLs, or birth
time only after a product requirement defines their cross-platform behavior.

### Snapshot

```ts
type Snapshot = {
	nodes: MapRoot<NodeId, Node>
	children: MapRoot<[parentId: NodeId, name: string], NodeId>
}
```

`nodes` is the source of node values. `children` is a derived index that makes path lookup
and directory listing efficient. Shared core code creates both roots together and checks
their invariants before it publishes them. An adapter never updates either map directly.

Both maps are persistent Merkle maps. An edit rewrites only the affected map blocks. Equal
subtrees keep equal object IDs. A diff skips equal blocks and visits changed blocks only.

### Commit

```ts
type Commit = {
	parents: readonly ObjectId[]
	snapshot: ObjectId
}

type Head = {
	lineageId: string
	commit: ObjectId
}
```

A normal commit has zero or one parent. A merge can have two parents. The commit object ID
is its idempotency key. A separate operation ID, ordered journal sequence, and per-node
revision are not required.

Each ref points to an immutable `Head` object. A normal write keeps the lineage ID. A reset
creates a new lineage ID, so a stale offline replica cannot publish changes against an old
history that happens to have the same tree.

The smallest durable sync state is a set of named references:

- `workspace`: the state used by the file API;
- `synced/<peer>`: the last state that local and that peer agreed on;
- `materialized`: the state last applied to a native working directory, when one exists.

The remote peer supplies its current head. It does not have to be copied into a local
mutable table.

### Content

For the first version, one file is one immutable content object. This matches the current
small-document workload. It also keeps reads, writes, verification, and garbage collection
simple.

If measured workloads contain large files, add one core-owned file manifest that refers to
fixed-size content blocks. This changes the object encoding. It does not change `BlockStore`
or `Node`.

## 3. Minimal implementation seam

### Required interface

```ts
interface BlockStore {
	/** Return exact immutable bytes, or null when the object is absent. */
	get(id: ObjectId): Promise<Uint8Array | null>

	/** Store exact immutable bytes. Repeating the same put is safe. */
	put(id: ObjectId, data: Uint8Array): Promise<void>

	/** Read one linearizable named reference. */
	readRef(name: string): Promise<ObjectId | null>

	/** Atomically change one reference only when it still has expected. */
	compareAndSwapRef(
		name: string,
		expected: ObjectId | null,
		next: ObjectId | null
	): Promise<boolean>
}
```

The shared repository layer owns canonical encoding, hashing, persistent maps, validation,
path resolution, file operations, state diff, merge, retry, and sync.

The adapter contract has these rules:

1. Objects are immutable. A second `put` for the same ID must keep the same bytes.
2. Core code verifies `hash(data) === id` on every untrusted read or transfer.
3. `compareAndSwapRef` is the only required atomic write.
4. A successful `put` is durable before its promise resolves. Core publishes a ref only
   after every required `put` resolves.
5. A failed compare-and-swap can leave unreachable objects. This is safe.
6. Ref reads and changes are linearizable for one repository.

Do not add transactions, directory operations, journals, snapshots, subscriptions, inode
allocation, or sync callbacks to this interface.

### Optional performance functions

Do not put these in the first required interface:

- batch `get` and `put`;
- range reads;
- a ref-change wake signal;
- object packing;
- garbage-collection iteration.

They do not change correctness. Add them as measured optimizations. Polling a ref is a valid
watch fallback. An implementation can run its own safe garbage collector until a common GC
helper is useful.

### Adapter mapping

| Adapter | Objects | References | Atomic compare-and-swap |
| --- | --- | --- | --- |
| Memory | `Map<ObjectId, Uint8Array>` | `Map<string, ObjectId>` | One synchronous check and set |
| SQLite | `objects(id, bytes)` | `refs(name, value)` | One short SQL transaction |
| PostgreSQL | Object table or object storage | Row in `refs` | Conditional update in a transaction |
| IndexedDB | `objects` object store | `refs` object store | One read-write transaction |
| Local disk | Files below an object directory | Small ref files | Lock, temporary file, fsync, and rename |

All adapters store the same canonical objects. They do not reimplement file operations or
sync rules.

## File API above the repository

The public file API can stay close to the current `Volume` API. `NodeId` can be the exposed
inode value. The repository layer implements path and file behavior:

- `stat`, `lstat`, and `exists` read one snapshot;
- `readFile` follows the content object from that snapshot;
- `writeFile`, `mkdir`, `symlink`, metadata edits, and xattr edits build a new snapshot and
  compare-and-swap `workspace`;
- `rename` updates the moved node and the location index in one new snapshot;
- `readdir` reads the child-index range for one parent;
- `scan` walks an immutable snapshot;
- `watch` waits or polls for a new `workspace` reference and then wakes the caller.

A local control queue serializes repository writes. I/O and hashing can run concurrently,
but head publication has one deterministic order. If another process wins the head race,
shared core code reads the new head, replays the operation, and tries again. An operation
that is no longer valid returns a normal file-system error.

## Sync algorithm

The sync planner first verifies that its saved base has the current remote lineage. A
lineage mismatch starts an explicit reset or adoption flow. It never enters the normal
merge.

The normal sync planner reads three immutable commits:

- `B`: the last commit saved in `synced/<peer>`;
- `L`: the current local `workspace` commit;
- `R`: the current remote commit.

It compares `B -> L` and `B -> R` by node ID.

For each changed node:

1. If only one side differs from `B`, take that side.
2. If both sides have the same value, take it.
3. If one side moves a node and the other side edits its content or portable metadata,
   merge the independent fields.
4. If both sides claim the same destination name, delete an edited ancestor, or change the
   same field differently, return an explicit conflict.

The first product policy can stop and report a conflict. It must not silently lose data or
invent conflict-copy names in the storage core.

After it builds merged commit `M`:

1. Put all missing immutable objects on the remote.
2. Compare-and-swap the remote head from `R` to `M`.
3. Compare-and-swap the local head from `L` to `M`.
4. Change `synced/<peer>` from `B` to `M`.

If any compare-and-swap fails, read the new heads and plan again. If a process crashes after
the remote accepts `M`, the next run sees `M` as remote state and completes the same merge.
No separate apply journal or snapshot session is required.

This is a central-authority protocol when only the server can change the remote head. The
same three-state planner can later create a two-parent merge commit for peer-to-peer sync.
The storage seam does not change.

## Local-only data and selective content

An ignore list combines three different requirements:

1. secret data that must not leave one host;
2. engine data that is not user file data;
3. shared metadata whose content does not need local materialization.

Do not solve these requirements with one path filter.

### Secret or host-local data

Mount a separate local repository at a fixed path such as `/private`. Mount paths are part
of the product namespace contract. Every replica reserves the same paths, even though each
local repository has different content.

```text
Volume /
  synced repository mounted at /
  local repository mounted at /private
```

The path router gives users one normal file API. Sync receives only the synced repository,
so no snapshot, delta, tombstone, blob request, or cursor can disclose the local repository.

A rename across repositories returns `EXDEV`, as a POSIX cross-filesystem rename does. A
caller can copy and then remove the source when it accepts the non-atomic behavior. This
replaces complex visible-to-ignored transition rules with one familiar boundary rule.

### Engine state

Store refs, objects, peer state, and credentials outside the user tree. Do not mount them
unless a diagnostic tool explicitly needs them. The sync engine must not ignore its own
files because its files are not part of the synchronized repository.

### Selective content

Replicate the node and content hash. Do not fetch the content object until a reader needs
it. This is a materialization choice, not an identity or visibility choice. It does not
change the tree or the sync base.

If the product later needs a user-defined path that is completely absent from sync, treat
it as a mount configuration. Do not add glob, negation, or per-peer projection rules to the
core protocol.

## Native working directory

A native directory can change outside this process. It cannot provide the same atomic
boundary as SQLite or IndexedDB. Treat it as a materialized view, not as the repository
database.

One maintained native bridge has two jobs:

1. Observe the directory and commit the observed state to `workspace`.
2. Apply a repository diff to the directory and change `materialized` only after it
   completes.

OS events are wake signals. A scan confirms state. After a crash, compare the directory,
`workspace`, and `materialized`, then repair or record the external edit. File IDs or a
small sidecar can improve rename detection, but they are private to this bridge.

This bridge contains native file-system complexity. It is not a seam that every storage
author must implement. Database, browser, and in-memory users read the repository directly.

## Prior art

- [Dropbox Nucleus](https://dropbox.tech/infrastructure/rewriting-the-heart-of-our-sync-engine)
  shows why stable node IDs and atomic moves are necessary. Dropbox reports that its old
  path identity expanded a directory move into descendant deletes and adds.
- [Dropbox sync testing](https://dropbox.tech/infrastructure/-testing-our-new-sync-engine)
  describes the Local, Remote, and Synced trees. It persists consistent observations and
  derives work from them. This proposal uses the same key idea.
- The [Unison specification](https://www.cis.upenn.edu/~bcpierce/papers/unisonspec.pdf)
  explains why two current replicas are not enough. A last-synced archive is required to
  distinguish create from delete.
- [Git objects](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects) show that blobs,
  trees, and commits can sit on a small content-addressed key-value store. Git does not keep
  stable file IDs, so its rename inference is not sufficient here.
- [IPFS UnixFS](https://docs.ipfs.tech/how-to/content-addressing-data-sets/) shows that an
  immutable root can verify a complete file collection and that directories can be
  first-class content-addressed objects. Its deep path traversal also shows why this design
  needs a dedicated location index and caching.
- [Syncthing BEP](https://docs.syncthing.net/specs/bep-v1.html) shows a practical path-keyed
  alternative with per-file version vectors, device-local sequence numbers, and content
  blocks. It is useful for content transfer, but its path identity does not meet the atomic
  subtree-move goal.

## Alternatives considered

### Keep the current `Storage` and add more sync capabilities

This is the lowest migration cost. It keeps two sources of truth and requires every durable
adapter to join tree state, node state, journal state, and snapshots. It does not solve the
reason that the seam grows.

### Use only a mutable node table

A node table with a transaction API can support stable IDs and efficient moves. It still
requires a portable transaction and index contract. Native files cannot implement that
contract, and IndexedDB transaction lifetime rules leak into shared code. Snapshot and
journal behavior also remain separate adapter duties.

### Use only a flat path-to-file map

This is very small and works for scans. A directory move changes every descendant key. It
cannot meet the main performance goal.

### Use only a Git-like path tree

This gives immutable snapshots and a small object store. Without stable node IDs, a move is
inferred from equal content. A move plus an edit is ambiguous. Add stable node IDs.

### Use operation logs as the source of truth

Operation logs help peer-to-peer replication. They make compaction, tombstones, ordering,
and path-policy changes part of the core model. Complete states plus a common base are
simpler for the current central-authority product.

## Final compression review

The proposal removes these required concepts:

- backend inode allocation;
- local-inode to sync-ID mapping in database-backed adapters;
- per-node revision counters;
- tombstone tables;
- ordered journal rows and numeric cursors;
- mutation observers and transaction-scoped tree ports;
- snapshot sessions and retained snapshot blobs;
- sync capability attachment to a file-system store;
- ignore-policy hashes, subscriptions, and projection transitions;
- different sync state models for SQLite, IndexedDB, memory, and native files.

The proposal keeps these concepts because removing any one breaks a required access pattern:

- stable node ID: required for moves and move-plus-edit merge;
- parent ID and name: required for location and directory operations;
- content hash: required for integrity and deduplication;
- two indexes: required for both node lookup and path lookup;
- immutable snapshot: required for atomic publication and stable scans;
- last-synced state: required to distinguish create from delete;
- repository lineage: required to fence stale replicas after a reset;
- one atomic compare-and-swap: required to publish a complete state safely.

The remaining complex code is the persistent map, the three-state merge, and the native
bridge. Each is shared or contained. Storage authors do not reimplement it.

## First implementation experiment

Do not migrate the current packages yet. First, test the model in a small isolated package.

1. Implement the four-method in-memory `BlockStore`.
2. Implement canonical object encoding and a persistent ordered map.
3. Implement `writeFile`, `readFile`, `readdir`, `rm`, and `rename` on one head ref.
4. Prove that a move of a directory with 4,000 descendants changes one node value, two
   location-index keys, and a bounded number of map blocks. It must not enumerate the
   descendants.
5. Implement a three-state diff for create, edit, move, delete, move-plus-edit, and name
   collision.
6. Run deterministic crash tests around every object put and head compare-and-swap.
7. Compare object count, bytes written, and latency with the current memory node adapter.

Stop the experiment if the persistent-map write amplification or global head contention is
too high. If contention is the only failure, test one control queue before adding sharded
heads or per-node revisions.
