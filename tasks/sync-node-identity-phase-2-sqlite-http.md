---
project: packages/sync
status: planned
source_issue: 464
---

# sync v2 phase 2: add the SQLite node store and HTTP replica path

## Parent

[sync node identity epic](./sync-node-identity.md)

## Type

AFK vertical slice through shared sync rules, SQLite persistence, server routes, HTTP client, and public integration tests.

## Blocked by

[phase 1: memory reference](./sync-node-identity-phase-1-memory.md)

## Context for a fresh agent

Phase 1 defines the v2 node mutation contract, memory reference adapter, and conformance behavior. Use it as the executable specification. Do not redesign the identity model in this task.

Read:

- `packages/core/src/storage.sqlite.ts` for filesystem transactions and the current path-sync ports.
- `packages/core/src/migrations/` for ordered SQLite migrations.
- `packages/core/src/fs.ts` and `fs.client.ts` for the Hono server and remote replica.
- `packages/core/src/db.sqlite.ts` for transaction serialization.
- `packages/core/src/storage.sqlite.conformance.test.ts` for shared adapter conformance.
- `packages/sync/replica.ts` and the v2 modules added by [phase 1: memory reference](./sync-node-identity-phase-1-memory.md).

The server is another replica. It stores only `SyncNodeId <-> its local Ino`. It does not store client inode IDs.

## What to build

Implement the phase-1 node-sync persistence interface for SQLite and expose a protocol-v2 HTTP replica path.

Add migration-owned tables for:

- sync node state and bidirectional local-inode lookup;
- accepted node mutation journal with a monotonic cursor;
- any minimal singleton state required for snapshot cursors or revision allocation.

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
- Blob validation happens before a content-bearing create or update is accepted.
- The server stamps authenticated origin information. It does not trust a client-supplied origin.
- A failed transaction exposes none of the filesystem change, mapping, node state, or journal row.
- v1 path synchronization remains functional and uses a separate cursor namespace.

This phase can use the deterministic revision rules from phase 1. Complete conflict policy lands in phase 4.

## Visibility boundary requirements

The SQLite and HTTP slice must enforce the visibility contract from the memory reference as a security boundary.

- Add an ignore-list subscription to the v2 handshake. The client sends its normalized list and hash. The server calculates the effective connection list as the union of its normalized list and the client's normalized list, then returns the normalized effective list, its hash, and the identity epoch.
- Before it accepts the subscription, the client normalizes the returned list, recalculates its hash, and verifies that it contains every client root. A mismatch is a typed protocol error and no cursor or projection state advances.
- Exclude effective ignored data from node snapshots, deltas, tombstones, and blob routes before serialization.
- The server independently reconstructs ancestry and rejects create, move, or publish operations under the effective connection list. A client cannot weaken the server list.
- `publishTree` can use resumable staging, but it validates every node and blob before one atomic filesystem, mapping, revision, and journal commit. Staged nodes are not visible.
- `unpublishTree` atomically verifies an exact descendant ID/revision manifest, removes the shared projection, and records tombstones. The client keeps its ignored local bytes without live mappings to old IDs.
- A visible root move that intersects a nested ignore root commits the top-level move and affected publish or unpublish manifests in one SQLite transaction.
- Server-local ignored nodes stay independent from same-path ignored nodes on clients.

### Additional RED/GREEN cycle: HTTP boundary security

**RED:** Give the server and client different ignore roots. Assert that the handshake returns the normalized union and a matching hash. Reject a response with a wrong hash or a missing client root before cursor advancement. Through HTTP, run all four root transitions and a visible-root move that crosses a nested ignore boundary. Inspect metadata and blob calls. Assert that the connection uses the union, no ignored destination or content crosses HTTP, each compound operation is all-or-nothing, unpublication removes the visible remote nodes, and retry is idempotent. Send a crafted mutation into either ignored root and assert rejection before blob fetch.

**GREEN:** Reuse the phase-1 planner. Add server validation, staged publication, transactional commit, and filtered transport.

### Added acceptance criteria

- [ ] A direct HTTP caller cannot weaken the server ignore list or bypass its own declared connection list.
- [ ] A client rejects an effective list whose hash is invalid or which omits one of its declared roots.
- [ ] Failed publication exposes no partial tree or ignored blob.
- [ ] Publish and unpublish survive SQLite restart and safe retry.

## RED/GREEN TDD specification

### Cycle 1: SQLite identity persistence

**RED:** Run the shared v2 conformance tracer for root binding and create against a fresh in-memory SQLite database. Close and reopen a file-backed database and assert that the same sync ID resolves to the same server-local inode.

**GREEN:** Add the migration, SQLite node store, root binding, and create transaction needed for this test.

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

**GREEN:** Persist and return the correct snapshot high-water and cursor tokens.

### Refactor only after GREEN

After all cycles pass, remove repeated encode/decode or transaction wiring. Do not merge v1 and v2 schemas into a broad generic mutation abstraction unless both real implementations become smaller.

## Acceptance criteria

- [ ] SQLite passes the shared v2 conformance suite.
- [ ] The HTTP client/server path passes create, bootstrap, update, move, delete, retry, restart, and snapshot/delta tests.
- [ ] A projection-preserving 4,000-descendant move between visible paths creates one source mutation and one server journal row.
- [ ] The SQLite projection-preserving visible-to-visible v2 move path performs no recursive CTE or descendant enumeration.
- [ ] A pure move uploads no blobs.
- [ ] Mapping, node state, journal, and filesystem writes share one transaction.
- [ ] The server never stores client-local inode IDs.
- [ ] V1 endpoints and conformance tests remain green.
- [ ] New migration tests work from both a fresh schema and every existing migration level.
- [ ] `pnpm format`, `pnpm typecheck`, `pnpm lint:fix`, and `pnpm test` pass.

## Out of scope

- Migration/backfill of an existing production tree into v2 identity. Phase 5 owns it.
- IndexedDB.
- Native filesystem.
- Final conflict and cycle policy.
- Removal of v1 tables or routes.
