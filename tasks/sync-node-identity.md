---
project: packages/sync
status: planned
source_issue: 462
---

# sync: replace path identity with stable node IDs for O(1) moves

## Problem

The filesystem tree is already inode-addressed. A database rename updates one `fs_dirents` row and emits one `TreeEffect.move`. The sync protocol is still path-addressed: `PathChange` supports only `put(path)` and `delete(path)`. `pathSyncObserver` therefore expands a move of a subtree with `N` nodes into `2N` journal rows.

A measured rename of a directory with 4,000 files produces 8,002 journal sequence entries and takes about 166 ms before network fanout. With a page size of 500, each peer needs 17 delta pages. The cost then repeats for every receiving replica.

[Issue #454](https://github.com/xiaoxinghu/justfiles/issues/454) and [PR #461](https://github.com/xiaoxinghu/justfiles/pull/461) created the required seam: the filesystem emits one transaction-scoped `move` effect, and the sync module decides how to record it. This epic uses that seam.

## Goal

Make sync identity independent of path. A move or rename that stays inside the synchronized projection must produce one durable node mutation, one wire mutation, and one atomic move on each receiving database-backed replica, regardless of subtree size.

## Identity model

- Every logical file and directory has one globally unique `SyncNodeId` shared by all replicas.
- Every replica, including the server, stores its own `SyncNodeId <-> local Ino` mapping.
- A replica never sends its local inode on the wire and never knows another replica's local inode.
- There is no separate server or remote ID.
- The creating replica generates the sync ID before it publishes the create. Use a collision-resistant UUID. This must work offline.
- The root has one well-known sync ID. Each replica binds it to its own `rootIno`.
- A new object at a previously used path gets a new sync ID.
- A deleted node keeps a tombstone with its sync ID and last accepted revision after its local inode is removed.
- An implementation may use the same UUID value for the local inode and sync ID, but no interface or test can depend on equality.

Example for one logical file:

```text
sync ID S-123
  client A: S-123 <-> local inode A-91
  client B: S-123 <-> local inode B-27
  server:   S-123 <-> local inode R-44
```

## Node state

Each replica must be able to persist at least:

```ts
type SyncNodeState = {
	id: SyncNodeId
	localIno: Ino | null
	parentId: SyncNodeId | null
	name: string
	type: FileType
	revision: number
	deleted: boolean
	contentHash?: string
}
```

The exact stored shape can differ by adapter. The sync module owns the meaning. `packages/fs` must not import sync vocabulary.

## Wire behavior

Protocol v2 carries node mutations, not paths or local inodes:

```ts
type NodeMutation =
	| { kind: 'create'; nodeId: SyncNodeId; parentId: SyncNodeId; name: string; baseRevision: 0; meta: SyncMeta; contentHash?: string }
	| { kind: 'update'; nodeId: SyncNodeId; baseRevision: number; meta: SyncMeta; contentHash?: string }
	| { kind: 'move'; nodeId: SyncNodeId; parentId: SyncNodeId; name: string; baseRevision: number }
	| { kind: 'delete'; nodeId: SyncNodeId; baseRevision: number }
```

The accepted wire schema can refine this shape. It must preserve these facts:

- Identity is `nodeId`.
- Location is `parentId + name`.
- Content remains hash-addressed and is not uploaded again for a move.
- Mutations are idempotent under retry.
- Parents are created before children.
- Deletes are applied child before parent when a recursive delete is represented as multiple node deletes.
- A projection-preserving visible-to-visible move never enumerates descendants.

## Visibility boundary

This section is normative. It narrows every unqualified move-cost statement in this task. Protocol v2 represents the synchronized projection of a local tree. It does not represent excluded local nodes.

### One generic ignore list

- Each replica receives one serializable `ignore: readonly string[]` list. The sync package contains no `/private` or other product-specific paths.
- An ignored path is outside that replica's synchronization projection in both directions. The replica keeps its own local bytes and does not bind them to another replica's same-path bytes.
- A connection uses the union of the server and client lists. A client can widen only its connection view; it cannot weaken the server list or delete server data by changing its list.
- The sync engine always excludes its own persisted state. This is an implementation invariant, not a business ignore rule.
- Apply visibility before outbound publication, inbound materialization, snapshot and delta generation, tombstone generation, and blob transfer.
- A node-addressed implementation must reconstruct the effective path by walking `parentId` links. A cache is permitted, but correctness cannot depend on a stale cache.
- No mutation can disclose an ignored destination path or post-boundary node metadata, content hash, or content. An unpublish operation can name only IDs that were already shared.
- The server must apply the effective connection list before serialization and mutation acceptance. The client must also enforce its own list on receive.
- An incoming delete, replacement, or move must not destroy or expose a locally ignored descendant. Preserve the current `shieldsIgnored` behavior: skip an unsafe apply and allow deliberate local divergence.

### Projection transitions

Classify a local move from its effective old and new paths. Root visibility alone is not sufficient. Scan the normalized ignore roots for an intersection below the old or new subtree and map each relative suffix to the other location.

- visible -> visible with no descendant visibility change: emit one `move`; preserve all IDs; do not enumerate descendants.
- ignored -> ignored: emit nothing.
- ignored -> visible: emit `publishTree`; enumerate parent before child; assign fresh sync IDs; upload only missing blobs.
- visible -> ignored: emit `unpublishTree`; tombstone formerly shared IDs; remove the remote subtree; keep local bytes.
- visible -> visible with an intersecting ignore root: emit one atomic projection-move operation. It moves the shared root and publishes or unpublishes only descendant subtrees whose visibility changes. This path is O(number of affected nodes), not O(1).

The intersection check walks the ignore list, not the moved filesystem subtree. Version 1 has absolute ignored roots without glob or negation syntax. Do not add a general pattern-transition planner here.

IDs do not survive a local filesystem move out of the synchronized projection. A later move back to a visible path publishes fresh IDs. A node that has always been ignored has no sync-ID mapping.

The server can own an independent node at a path ignored by a client. A client can keep non-materialized remote node state with `localIno: null`, but it must not bind that state to same-path local ignored content. On a remote ignored -> visible transition, fetch and materialize the complete subtree. On visible -> ignored, remove only the synchronized materialization and do not echo a server delete.

### Ignore-list changes

- Sync normalizes and hashes each list. The caller does not supply a version.
- The client sends its normalized list and hash when it opens a sync subscription. The server combines it with its own list and returns the normalized effective list, effective hash, and identity epoch. The client verifies the hash and that the effective list contains every client root before it accepts the subscription.
- The client uses the returned effective list for reconciliation and both-direction filtering. It persists that list with its hash. Every snapshot and delta cursor is bound to the effective hash.
- A changed hash invalidates the old projection cursor and runs automatic best-effort reconciliation before normal push and pull.
- Adding an ignore root masks matching nodes and preserves each replica's local bytes. The policy change alone emits no user delete and does not delete another replica's copy.
- Removing an ignore root compares the filtered remote snapshot with local bytes. Remote wins a same-path conflict; equal content binds to the remote ID; a local-only path publishes with fresh IDs. Data loss is permitted when remote wins.
- An existing account with no saved policy hash performs the same full reconciliation and records a baseline.
- Reconciliation is resumable and internal to sync. Application code supplies only the ignore list.
- Do not assume coordinated deployment. Clients can run different lists during a rolling release. Each connection enforces its current effective list and reconciles when that replica later opens with a new hash.
- A policy change is best effort, not an atomic account-wide cutover. Sync does not promise temporary cross-client visibility consistency, historical reconstruction, or a lossless merge while releases are mixed. Normal convergence resumes after active replicas use the new policy.

### Boundary operations

- `publishTree(parentId, name, manifest)` is one logical operation with an O(N) parent-first manifest. Large manifests can use resumable staging, but no partial tree can become visible.
- `unpublishTree(rootId, manifest)` is one logical wire operation. Its child-first manifest contains the expected ID and revision of every live shared node being removed. At commit, the server verifies that this is the exact current subtree, with no added, removed, moved, or updated descendant.
- Do not maintain an aggregate revision up every ancestor. Exact manifest validation keeps unpublication O(N) without adding path-length write fanout to ordinary descendant updates.
- A projection move that intersects nested ignore roots commits its top-level move and all required publish and unpublish manifests atomically. No intermediate path can expose ignored data.
- Retry is idempotent. Failure before commit exposes no projection change. Retry after commit returns the accepted result.
- A stale revision or name collision rejects the complete operation and requires pull/replan. Do not create conflict-copy names in this work.

Boundary work is intentionally O(N). The O(1) guarantee applies only to projection-preserving visible -> visible moves.

### Required security tests

- [ ] Engine state and caller-ignored paths never appear in snapshots, deltas, mutations, tombstones, blob requests, or blob responses.
- [ ] A projection-preserving visible -> visible move produces one move for 0, 1, 100, and 4,000 descendants.
- [ ] A visible -> visible root move that crosses a nested ignore root atomically publishes or unpublishes the affected descendant subtree and never exposes it at an ignored path.
- [ ] ignored -> ignored produces no wire work.
- [ ] ignored -> visible publishes the complete subtree parent first with fresh IDs.
- [ ] visible -> ignored removes the complete remote subtree while local ignored bytes survive.
- [ ] A remote mutation cannot inject a path ignored by the receiving replica or effective connection policy.
- [ ] A remote ancestor delete or replacement cannot destroy a locally ignored descendant.
- [ ] An ignored -> visible receive fetches missing descendants; visible -> ignored does not echo a delete.
- [ ] A changed ignore list reconciles automatically on launch and an unchanged list does no scan or cursor reset.
- [ ] Crash and retry cannot expose a partial publication or leak an ignored blob.
- [ ] A concurrent descendant update or addition rejects a stale unpublish manifest without partial removal.

## Server authority and conflicts

The current topology is client-server. The server serializes accepted node mutations and assigns the next revision.

- A mutation names the last server revision observed by the author.
- A mutation against an unknown node fails, except for `create`.
- Repeating an already accepted mutation is an idempotent success.
- A stale update, move, or delete must not silently overwrite newer state.
- A create or move cannot claim a `(parentId, name)` held by another live node.
- A parent must exist and be a live directory.
- A directory cannot move below itself or create a cycle.
- A deleted sync ID cannot be rebound to a new local inode as a new object.
- The server returns enough accepted state for the author to advance without receiving its own echo.
- Other clients receive the accepted node ID, location, metadata, and revision through the ordered change stream.

Conflict product behavior must be deterministic. The first implementation can reject stale or colliding mutations and require a pull/replan. Do not invent conflict-copy names in this epic.

## Adapter seam

`Storage` is the only required filesystem interface. Sync progressively selects the
best available strategy:

| `caps.sync` | `caps.content` | Strategy |
| --- | --- | --- |
| absent | absent | full-tree reconciliation over ordinary inode blobs |
| absent | present | full-tree reconciliation with hash lookup and deduplication |
| present | absent | stable node identity and incremental deltas with eager ordinary-blob transfer |
| present | present | stable node identity, incremental deltas, direct hash transfer, and efficient snapshots |

Every capability is optional. Absence degrades performance or consistency, not
viability. With only `Storage`, sync guarantees convergence through full
reconciliation when writes eventually quiesce; it does not promise atomic snapshots,
stable rename identity, incremental cursors, or O(1) moves.

The runtime extension is named `storage.caps.sync`, but its type is owned entirely by
`packages/sync` as a structural refinement of `StorageCapabilities`. Do not declare
`sync` or import `SyncCapability` in `packages/fs`. This preserves the dependency
direction (`sync` depends on `fs`) without a generic registry or module augmentation.

`caps.sync` and `caps.content` are independent. Content hashes remain on the wire,
but a replica without `caps.content` reads and verifies bytes through ordinary inode
blob operations and materializes them eagerly. A snapshot must retain those bytes
until close or fail before returning its token.

`packages/sync` defines the shared node rules and a small internal adapter seam. A
backend supplies transaction-scoped tree access, node state/journal persistence,
mutation observation, and an owned snapshot cut; shared code constructs the
`SyncCapability`. Backend authors do not reimplement mutation folding, apply
ordering, snapshot paging, or delta handoff.

The adapter has integration implementations for:

- memory, as the reference and conformance adapter;
- SQLite, used by the server and database-backed hosts;
- IndexedDB, used by browser clients;
- native filesystem, using a persisted sidecar index and reconciliation because POSIX cannot join a sidecar transaction.

SQLite and IndexedDB must commit the filesystem mutation, identity mapping, accepted node state, and journal row atomically. Native filesystem support documents and tests its weaker crash model and repairs by reconciliation.

The detailed boundary and fallback behavior is implemented before durable adapters
in [progressive storage capabilities](./sync-progressive-storage-capabilities.md).

## Compatibility

Protocol v2 must ship beside path protocol v1 until a separate removal phase proves that deployed clients no longer require v1.

- The handshake advertises supported protocol versions.
- A client selects one protocol for a sync cycle. It cannot mix v1 and v2 cursors.
- Existing trees are backfilled without changing file content or user-visible paths.
- Mixed-version server operation must keep v1 and v2 clients convergent during the compatibility window, even though a move can still fan out on the v1 side.
- Cutover uses lineage/generation fencing so a stale cursor cannot cross identity models.

## Non-goals

- Do not rewrite `packages/fs`.
- Do not implement Dropbox's full Local/Remote/Synced three-tree planner only to fix rename fanout.
- Do not add hard links. The current one-dirent-per-inode rule stays.
- Recursive delete and visibility-boundary publication or unpublication can remain O(N) in v2. Only a projection-preserving visible-to-visible move or rename must be independent of subtree size.
- Do not expose sync IDs through the public `Volume` interface unless a later user-facing requirement needs it.

## TDD rule for all phases

Use vertical RED -> GREEN cycles. Add one behavior test, confirm that it fails for the expected reason, add the minimum implementation, and confirm that it passes before the next test. Test through public sync, replica, and volume interfaces. Do not test private helpers or database rows when observable behavior is available.

Each phase task contains its own ordered RED/GREEN specification.

## Phases

Complete the tasks in this order:

- [x] [phase 1: memory reference](./sync-node-identity-phase-1-memory.md)
- [x] [snapshot handoff](./sync-node-identity-snapshot-handoff.md)
- [x] [progressive storage capabilities](./sync-progressive-storage-capabilities.md)
- [x] [phase 2: SQLite and HTTP](./sync-node-identity-phase-2-sqlite-http.md)
- [ ] [phase 3: IndexedDB](./sync-node-identity-phase-3-indexeddb.md)
- [ ] [phase 4: authority and conflicts](./sync-node-identity-phase-4-authority-conflicts.md)
- [ ] [ignore-policy reconciliation](./sync-node-identity-ignore-policy-reconciliation.md)
- [ ] [phase 5: migration](./sync-node-identity-phase-5-migration.md)
- [ ] [phase 6: native filesystem](./sync-node-identity-phase-6-native-fs.md)
- [ ] [phase 7: retire path v1](./sync-node-identity-phase-7-retire-v1.md)

## Global acceptance criteria

- [ ] Moving a visible directory to another visible path with 4,000 descendants appends exactly one v2 move mutation on the source and server when no ignore root changes descendant visibility.
- [ ] A projection-preserving visible-to-visible move uses no subtree enumeration in the v2 observer or applier.
- [ ] Every receiving database-backed replica applies the move through one atomic top-entry rebind.
- [ ] No file content is uploaded for a pure move.
- [ ] Create, update, move, delete, offline create, retry, restart, and bootstrap converge across memory, SQLite, and IndexedDB adapters.
- [ ] Stale revisions, missing parents, occupied names, and cycles have deterministic tested results.
- [ ] One generic per-replica ignore list is reconciled automatically when it changes, including existing accounts with no saved policy hash.
- [ ] A deleted path followed by a new create has two distinct sync IDs.
- [ ] Native filesystem restart and crash reconciliation restore a correct mapping and change stream.
- [ ] Every combination of absent/present `caps.sync` and `caps.content` remains syncable and selects the documented strategy.
- [ ] A plain `Storage` converges through the full-scan fallback without implementing sync-owned interfaces.
- [ ] Protocol v1 is removed only after compatibility and migration tests pass.
- [ ] `packages/fs` contains no sync capability declaration, sync ID, revision, node journal, snapshot-session, or protocol concepts.
- [ ] `pnpm format`, `pnpm typecheck`, `pnpm lint:fix`, and `pnpm test` pass after every phase.
