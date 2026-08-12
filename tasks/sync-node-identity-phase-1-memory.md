---
project: packages/sync
status: planned
source_issue: 463
---

# sync v2 phase 1: prove stable node identity and constant-cost moves in memory

## Parent

[sync node identity epic](./sync-node-identity.md)

## Type

AFK tracer-bullet implementation. No production adapter changes.

## Blocked by

None. [Issue #454](https://github.com/xiaoxinghu/justfiles/issues/454) and [PR #461](https://github.com/xiaoxinghu/justfiles/pull/461) already provide the transaction-scoped `TreeEffect` observer seam.

## Context for a fresh agent

Read these files first:

- `packages/fs/storage.shared.ts`: `TreeEffect`, `TreePort`, and `MutationObserver`.
- `packages/fs/storage.mem.ts`: the inode tree and extension attachment seam.
- `packages/sync/wire.ts`: current path protocol. Do not break it in this phase.
- `packages/sync/path.ts`: current observer; its `move` branch enumerates the subtree and emits `2N` path changes.
- `packages/sync/replica.ts`: current path replica roles and conformance seams.
- `packages/sync/storage/mem.ts`: current sync-enabled memory adapter.
- `packages/sync/sync-test-harness.ts`: public behavior test style.

The filesystem is already ID-addressed locally. This phase proves a second sync recorder over the same memory filesystem. It must turn one `TreeEffect.move` into one node mutation without editing the filesystem's move implementation.

## What to build

Add an experimental protocol-v2 module in `packages/sync`. Keep path protocol v1 operational and unchanged.

Define these domain concepts in sync vocabulary:

- `SyncNodeId`: shared logical node identity.
- `NodeMutation`: `create`, `update`, `move`, and `delete` mutations addressed by sync ID.
- `NodeState`: the last accepted local sync state for a node.
- A minimal persistence interface that supports bidirectional `SyncNodeId <-> local Ino` lookup, live state, tombstones, an ordered journal, and a consistent snapshot.

Build an in-memory adapter and a node-aware mutation observer. The adapter is the reference behavior for later SQLite and IndexedDB implementations.

A node create must bind a generated sync ID to the local inode in the same logical commit as its journal record. A visible-to-visible move must look up only the moved node and destination parent IDs. It must not call `enumerateSubtree`.

Add a memory-to-memory v2 replica path that can:

1. bootstrap an empty replica from a node snapshot;
2. push ordered node mutations;
3. apply them to another memory filesystem;
4. retain the same sync IDs while each replica uses its own local inodes;
5. transfer regular-file content by existing content hash behavior.

It is acceptable to add a separate experimental constructor such as `nodeSynced` or `nodeSyncReplica`. Do not make the production `synced()` select v2 yet.

## Required behavior

- The root uses one well-known sync ID on every replica and maps to each replica's own `rootIno`.
- A client can create a node offline and generate its final sync ID without a server round trip.
- A child mutation references its parent by sync ID.
- A create on a receiver mints or selects a receiver-local inode and binds it to the received sync ID.
- A move mutation contains only moved node ID, destination parent ID, destination name, and revision information.
- Applying a visible-to-visible move preserves the moved node ID and all descendant IDs and content hashes.
- A pure move transfers no content bytes.
- Repeating an accepted mutation is idempotent.
- Delete removes the local inode binding but retains a tombstone for the sync ID.
- Recreating the same path creates a new sync ID.
- Snapshot order is parent before child. Recursive delete order is child before parent.
- Hard links stay unsupported.

For this phase, use deterministic single-writer revisions in the in-memory reference. Full server-authoritative stale-write and collision rules are phase 4.

## Visibility boundary requirements

Phase 1 defines visibility in the shared v2 contract. Read `syncIgnore`, `PRIVATE_PREFIXES`, and `shieldsIgnored` in `packages/sync/replica.ts` first.

- Add a minimal canonical-path visibility policy. Built-in private prefixes are always active. A host policy can only add exclusions.
- The node store is the synchronized projection. Purely ignored local nodes have no sync-ID mapping.
- A live server-known node that this host does not materialize can have `localIno: null`. It is not a tombstone and must not bind to same-path local ignored content.
- Add logical `publishTree` and `unpublishTree`. Publication assigns fresh IDs and is parent-first. Unpublication tombstones old shared IDs while it preserves local bytes.
- Resolve both effective paths from the moved inode and parent chains before classification. Do not decide visibility from `parentId + name` alone.
- Apply visibility before snapshots, deltas, tombstones, blobs, and incoming tree changes.

### Cycle 8: private data is absent from the wire

**RED:** Create, update, and delete files under `/.state` and `/private` on both memory replicas. Assert that snapshots, deltas, tombstones, mutations, and blob calls never contain them. Assert that each replica keeps its own bytes.

**GREEN:** Add projection filtering at node snapshot, delta, apply, and blob boundaries.

### Cycle 9: all four local move transitions

**RED:** Test visible -> visible, ignored -> ignored, ignored -> visible, and visible -> ignored with a nested subtree. Assert one move, zero operations, one complete publication, and one logical unpublication. Assert fresh IDs after republish and local-byte survival after unpublish.

**GREEN:** Add path reconstruction and the minimal projection planner. Enumerate descendants only for publish and unpublish.

### Cycle 10: receiving projection and ancestor shielding

**RED:** Give replica B a nested host ignore. Move a remote subtree across B's boundary in both directions. Assert subtree fetch or local removal without echo. Send a remote ancestor delete and file replacement. Assert that B preserves its ignored child and skips the unsafe apply.

**GREEN:** Persist non-materialized remote state as needed, fetch on ignored -> visible receive, and port `shieldsIgnored` to node mutations.

### Added acceptance criteria

- [ ] Memory v2 applies the same built-in and host ignore policy in both directions.
- [ ] Private nodes do not acquire sync IDs and private hashes never reach the blob protocol.
- [ ] IDs are not reused after unpublish and later republish.
- [ ] Only visible -> visible moves have the no-enumeration guarantee.

## RED/GREEN TDD specification

Complete one cycle before starting the next.

### Cycle 1: shared identity on create

**RED:** Add a public integration test that creates `/docs/note.md` on replica A, syncs to empty replica B, and asserts through the node-sync interface that both replicas use the same node IDs for `/docs` and `/docs/note.md` while their local inode IDs can differ.

**GREEN:** Add `SyncNodeId`, the minimal identity/state store, root binding, create recording, snapshot, and receive-side create materialization needed for this test only.

### Cycle 2: one move mutation

**RED:** Create `/old` with several descendants, clear or advance the source journal, rename `/old` to `/new`, and assert that the v2 delta contains exactly one `move`. Sync it and assert that B exposes all descendants under `/new` and none under `/old`.

**GREEN:** Record `TreeEffect.move` as one node mutation and apply it through the existing atomic move capability. Do not enumerate descendants.

### Cycle 3: cost is independent of subtree size

**RED:** Move a directory between two visible paths with 4,000 files and assert exactly one new v2 journal row, one outgoing node mutation, and zero blob uploads. Do not use a wall-clock threshold.

**GREEN:** Remove any remaining descendant scan or per-child write from the v2 move path.

### Cycle 4: update keeps identity

**RED:** Edit an existing file after initial sync. Assert that the receiver gets new bytes and metadata under the same node ID and location.

**GREEN:** Add the minimal `update` record and apply behavior using the existing content-hash store.

### Cycle 5: delete tombstone and path reuse

**RED:** Delete `/docs/note.md`, sync, recreate a new file at the same path, and sync again. Assert that the old node ID remains deleted and the new file has a different node ID on both replicas.

**GREEN:** Add tombstone retention, delete apply, and fresh-ID create behavior.

### Cycle 6: retry is idempotent

**RED:** Deliver the same create, move, update, and delete mutation twice. Assert one logical node, one final location, one final revision, and no orphaned inode.

**GREEN:** Add mutation identity or accepted-revision checks sufficient to make retry safe.

### Cycle 7: ordered bootstrap

**RED:** Bootstrap a deep tree into an empty replica with a small page size. Assert that every parent mapping exists before a child is applied and that deltas after the frozen snapshot cursor are not lost.

**GREEN:** Add consistent node snapshot paging and delta resume behavior equivalent to the current path snapshot guarantee.

### Refactor only after GREEN

Remove duplication and deepen the node-sync module only after all cycles pass. Keep the public interface minimal. Do not generalize path v1 and node v2 unless the completed behavior proves that they share a useful interface.

## Acceptance criteria

- [ ] Protocol v1 tests remain unchanged and green.
- [ ] A public memory v2 conformance suite covers create, bootstrap, update, move, delete, retry, and path reuse.
- [ ] A 4,000-descendant rename between visible paths produces one v2 move row and zero content uploads.
- [ ] The visible-to-visible v2 move recorder and applier never call `TreePort.enumerateSubtree`.
- [ ] Each replica owns only its `sync ID <-> local inode` mapping.
- [ ] No test depends on local inode and sync ID values being equal.
- [ ] Tombstones retain identity after the local inode is removed.
- [ ] `packages/fs` gains no sync imports or sync concepts.
- [ ] `pnpm format`, `pnpm typecheck`, `pnpm lint:fix`, and `pnpm test` pass.

## Out of scope

- SQLite and HTTP transport.
- IndexedDB persistence.
- Native filesystem observation.
- Mixed v1/v2 deployment.
- Full stale-revision, name-collision, and directory-cycle policy.
