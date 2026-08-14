---
project: packages/sync
status: done
source_issue: 464
---

# sync v2 phase 2: add the SQLite node store and HTTP replica path

## Parent

[sync node identity epic](./sync-node-identity.md)

## Type

AFK vertical slice through shared sync rules, SQLite persistence, server routes, HTTP client, and public integration tests.

## Blocked by

- [phase 1: memory reference](./sync-node-identity-phase-1-memory.md)
- [snapshot handoff](./sync-node-identity-snapshot-handoff.md)
- [progressive storage capabilities](./sync-progressive-storage-capabilities.md) for the `caps.sync` boundary, shared capability construction, and content-independent fallback.

## Context for a fresh agent

Phase 1 defines the v2 node mutation contract, memory reference adapter, and delta
conformance behavior. The snapshot handoff task defines the internal current-state
bootstrap contract. Use both as executable specifications. Do not redesign either
contract in this task.

Read:

- `packages/core/src/storage.sqlite.ts` for filesystem transactions and the current path-sync ports.
- `packages/core/src/migrations/` for ordered SQLite migrations.
- `packages/core/src/fs.ts` and `fs.client.ts` for the Hono server and remote replica.
- `packages/core/src/db.sqlite.ts` for transaction serialization.
- `packages/core/src/storage.sqlite.conformance.test.ts` for shared adapter conformance.
- `packages/sync/replica.ts` and the v2 modules added by [phase 1: memory reference](./sync-node-identity-phase-1-memory.md).

The server is another replica. It stores only `SyncNodeId <-> its local Ino`. It does not store client inode IDs.

## What to build

Implement the internal transactional sync adapter for SQLite, construct the shared
`SyncCapability`, and expose it as `storage.caps.sync`. Do not expose a top-level
`nodeSync`/`sync` property or copy the memory sync rules into SQLite.

Phase 2 is the second implementation of the primitive seam introduced by
[progressive storage capabilities](./sync-progressive-storage-capabilities.md).
Refine that internal seam where SQLite proves it necessary, but keep node state,
journal, snapshot sessions, and transaction ports out of the package-root backend
author surface.

Add migration-owned tables for:

- sync node state and bidirectional local-inode lookup;
- accepted node mutation journal with a monotonic cursor;
- snapshot-session state required by the internal handoff contract;
- any minimal singleton state required for revision allocation.

Suggested logical constraints:

```sql
sync_id PRIMARY KEY
local_ino UNIQUE NULLABLE
UNIQUE(parent_sync_id, name) for live nodes
```

Use the schema that best fits SQLite and existing migration conventions. Do not add sync columns to `fs_inodes` or `fs_dirents`.

For all database-owned mutations, commit these facts together:

1. filesystem inode or dirent change;
2. sync-ID mapping change;
3. node state and revision change;
4. ordered journal row.

Expose v2 snapshot, delta, mutation-apply, blob-presence, and blob-transfer behavior through `createFsApi` and `remoteSyncReplica` or a new v2-specific remote constructor. Keep v1 endpoints working.

A fresh SQLite server and a memory client must be able to create, update, move, delete, restart, and bootstrap through the HTTP interface.

## Required behavior

- The server binds the well-known root sync ID to its current `ROOT_INO` during initialization.
- A client-generated sync ID is persisted without replacement.
- Receiving a create allocates a server-local inode and binds it to the supplied sync ID.
- Receiving a projection-preserving visible-to-visible move resolves the node and both parents through the server's mappings, then performs one atomic top-entry move.
- A projection-preserving visible-to-visible move does not enumerate descendants and does not add per-descendant journal or version state.
- Accepted mutations use one ordered server cursor and survive process restart.
- Snapshot paging freezes the delta high-water at snapshot start.
- SQLite advertises optimized sync only through the sync-owned structural
  `caps.sync` refinement; `packages/fs` gains no sync vocabulary.
- The capability remains usable when `caps.content` is hidden: transfer is eager
  through ordinary blob operations, even if SQLite internally stores blobs by hash.
- Blob validation happens before a content-bearing create or update is accepted.
- The server stamps authenticated origin information. It does not trust a client-supplied origin.
- A failed transaction exposes none of the filesystem change, mapping, node state, or journal row.
- v1 path synchronization remains functional and uses a separate cursor namespace.

This phase can use the deterministic revision rules from phase 1. Complete conflict policy lands in phase 4.

## RED/GREEN TDD specification

### Cycle 1: SQLite identity persistence

**RED:** Run the shared v2 conformance tracer for root binding and create against a fresh in-memory SQLite database. Close and reopen a file-backed database and assert that the same sync ID resolves to the same server-local inode.

**GREEN:** Add the migration, SQLite node store, root binding, and create transaction needed for this test.

Construct the capability with the shared adapter factory and expose it at
`caps.sync`; do not add another SQLite-specific sync facade.

### Cycle 2: HTTP create

**RED:** Through the typed Hono client, create `/docs/note.md` from a memory replica against a fresh SQLite server. Assert convergence through the public volume and node-sync interfaces after a new client bootstraps.

**GREEN:** Add the smallest v2 snapshot, mutation, and remote-replica transport path needed for create and bootstrap.

### Cycle 3: HTTP constant-cost move

**RED:** Seed 4,000 descendants, advance the v2 cursor, rename the root directory between visible paths with no intersecting ignore root, and sync through HTTP. Assert one outgoing move, one new server journal row, no blob PUT, and the full tree under the new path on a new bootstrap client.

**GREEN:** Resolve sync IDs to server-local inodes and use one atomic move. Do not enumerate descendants.

### Cycle 4: update and content validation

**RED:** Update a regular file through HTTP and assert that the server rejects the mutation if its content hash is absent, accepts it after upload, and serves the new content under the unchanged node ID.

**GREEN:** Reuse the existing hash-addressed blob transfer and presence checks for node mutations.

### Cycle 5: delete and path reuse

**RED:** Delete a node, restart the server, and create a new node at the same parent and name. Assert that the old sync ID remains a tombstone and the new node has a new sync ID.

**GREEN:** Persist null local-inode tombstones and enforce new identity on create.

### Cycle 6: transaction rollback

**RED:** Inject or provoke a failure after the filesystem write but before journal completion. After rollback, assert through public replica and volume behavior that neither the node nor its delta exists. Repeat for move and delete.

**GREEN:** Join the node store and observer to the existing transaction-scoped port. Do not add compensation logic outside the transaction.

### Cycle 7: snapshot/delta handoff

**RED:** Start a paged snapshot, mutate the server between pages, finish the snapshot, and resume deltas from its frozen cursor. Assert no missing or duplicated logical mutation after idempotent apply.

**GREEN:** Implement the internal snapshot-session contract with a SQLite-consistent state/content cut and return its high-water and opaque cursor tokens.

### Refactor only after GREEN

After all cycles pass, remove repeated encode/decode or transaction wiring. Do not merge v1 and v2 schemas into a broad generic mutation abstraction unless both real implementations become smaller.

## Acceptance criteria

- [x] SQLite passes the shared v2 conformance suite.
- [x] The HTTP client/server path passes create, bootstrap, update, move, delete, retry, restart, and snapshot/delta tests.
- [x] A projection-preserving 4,000-descendant move between visible paths creates one source mutation and one server journal row.
- [x] The SQLite projection-preserving visible-to-visible v2 move path performs no recursive CTE or descendant enumeration.
- [x] A pure move uploads no blobs.
- [x] Mapping, node state, journal, and filesystem writes share one transaction.
- [x] SQLite uses the shared capability construction and exposes it only as
  `caps.sync` from `packages/sync`'s structural refinement.
- [x] Hiding `caps.content` selects eager ordinary-blob transfer without disabling
  SQLite node sync.
- [x] The server never stores client-local inode IDs.
- [x] V1 endpoints and conformance tests remain green.
- [x] New migration tests work from both a fresh schema and every existing migration level.
- [x] `pnpm format`, `pnpm typecheck`, `pnpm lint:fix`, and `pnpm test` pass.

## Out of scope

- Migration/backfill of an existing production tree into v2 identity. Phase 5 owns it.
- IndexedDB.
- Native filesystem.
- Final conflict and cycle policy.
- Ignore-list projection and boundary transitions; the dedicated reconciliation task owns them.
- Removal of v1 tables or routes.
