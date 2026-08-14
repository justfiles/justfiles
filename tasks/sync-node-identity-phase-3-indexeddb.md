---
project: packages/sync
status: planned
source_issue: 465
---

# sync v2 phase 3: persist node identity in IndexedDB and sync browser clients

## Parent

[sync node identity epic](./sync-node-identity.md)

## Type

AFK vertical slice through IndexedDB persistence, browser-local transactions, remote SQLite transport, and conformance tests.

## Blocked by

- [phase 1: memory reference](./sync-node-identity-phase-1-memory.md) for the shared v2 contract and memory reference behavior.
- [phase 2: SQLite and HTTP](./sync-node-identity-phase-2-sqlite-http.md) for the production v2 HTTP server path.

## Context for a fresh agent

Read:

- `packages/fs/storage.idb.ts` for IndexedDB schema upgrades, transaction store sets, and filesystem operations.
- `packages/sync/storage/idb.ts` for current path journal persistence.
- `packages/sync/storage/idb.journal.test.ts` and `sync-conformance.test.ts` for fake-IndexedDB test patterns.
- The v2 memory conformance suite from [phase 1: memory reference](./sync-node-identity-phase-1-memory.md).
- The internal current-state bootstrap contract from [snapshot handoff](./sync-node-identity-snapshot-handoff.md).
- The v2 HTTP transport from [phase 2: SQLite and HTTP](./sync-node-identity-phase-2-sqlite-http.md).

IndexedDB can atomically update several object stores in one transaction. Use this to commit the local tree change, sync-ID mapping, node state, and node journal together. Do not store sync fields on inode or directory-entry records.

## What to build

Implement the shared v2 node-sync persistence interface for IndexedDB.

Add versioned object stores or indexes for:

- node state keyed by sync ID;
- unique local-inode-to-sync-ID lookup;
- ordered node mutation journal;
- snapshot-session and cursor state required by the internal handoff contract.

Upgrade existing databases without losing files, content hashes, dirty-content state, path-v1 state, or application data.

Wire an IndexedDB-backed browser replica to the v2 HTTP server from [phase 2: SQLite and HTTP](./sync-node-identity-phase-2-sqlite-http.md). Do not switch the production `synced()` default yet; expose explicit v2 selection for tests and later rollout.

## Required behavior

- Root binding uses the common root sync ID and the IndexedDB filesystem's own `rootIno`.
- Offline create generates and persists the final sync ID before any server contact.
- A transaction cannot expose a file-system node without its mapping and journal row.
- A received create uses a local inode that can differ from the server and other clients.
- A received projection-preserving visible-to-visible move resolves node and parent sync IDs locally and performs one top-entry move.
- A projection-preserving visible-to-visible move of any subtree size adds one local v2 journal row and sends one node mutation.
- A pulled mutation is tagged so it does not echo back as a new local mutation.
- A deleted node keeps a durable tombstone while its local inode binding becomes null.
- Restart preserves mapping, tombstone, cursor, and pending local mutations.
- Existing lazy-content and dirty-content guarantees remain intact.
- Path protocol v1 object stores remain usable during compatibility.

## RED/GREEN TDD specification

### Cycle 1: fresh IndexedDB create

**RED:** Run the shared v2 root/create conformance behavior against a fresh fake-IndexedDB database. Close and reopen it. Assert that sync IDs and local inode bindings survive.

**GREEN:** Add the object stores, indexes, root initialization, and create transaction needed for this behavior.

### Cycle 2: schema upgrade preserves existing data

**RED:** Create a database at the current pre-v2 version with a live tree, content, dirty markers, v1 cursors, and tombstones. Upgrade it. Assert through public filesystem and v1 sync interfaces that all existing behavior and state remain available.

**GREEN:** Add the minimal non-destructive IndexedDB version upgrade. Do not backfill v2 identity yet; phase 5 owns production backfill.

### Cycle 3: offline create to SQLite server

**RED:** Create a directory and child file while the IndexedDB client is disconnected. Reopen the browser database, connect to the SQLite HTTP server, sync, and assert that a new client bootstraps the same sync IDs and content.

**GREEN:** Wire the persisted local node journal to the v2 remote replica.

### Cycle 4: constant-cost move

**RED:** Create 4,000 descendants in IndexedDB, advance the v2 cursor, rename the ancestor between visible paths with no intersecting ignore root, and sync. Assert one outgoing move, one new local v2 journal row, one server row, and zero blob uploads.

**GREEN:** Record and apply the top-entry move without `enumerateSubtree`, cursors, or writes per descendant.

### Cycle 5: pulled move does not echo

**RED:** Move the directory from a second client, pull it into IndexedDB, then run another push. Assert that the push contains no mutation caused only by that pull.

**GREEN:** Persist the local apply source or accepted mutation identity in the same transaction and filter it from the outbound stream.

### Cycle 6: delete, restart, and path reuse

**RED:** Pull a delete, close and reopen IndexedDB, then create a new file at the same location. Assert that the old sync ID remains deleted and the new file receives a new ID.

**GREEN:** Add durable tombstone and unbound-local-inode behavior.

### Cycle 7: aborted transaction has no partial identity

**RED:** Abort a create, move, update, and delete transaction after the tree write is staged. Reopen the database and assert that neither tree state, mapping, node state, nor journal exposes the failed mutation.

**GREEN:** Ensure every store used by the operation joins one IndexedDB transaction.

### Cycle 8: lazy content remains correct

**RED:** Bootstrap with lazy content, move the containing directory before hydration, then read the file. Assert hydration by unchanged content hash succeeds at the new path and does not create an update mutation.

**GREEN:** Resolve hydration through node state and the existing content store without changing identity or revision.

## Acceptance criteria

- [ ] IndexedDB passes the shared v2 conformance suite.
- [ ] Upgrade tests preserve all existing file, blob, dirty, v1 sync, and application state.
- [ ] Offline create survives restart and later syncs with its original client-generated sync ID.
- [ ] A projection-preserving 4,000-descendant move between visible paths creates one local and one server v2 row, with no content upload.
- [ ] Pulled changes do not echo.
- [ ] Tombstones and mappings survive restart.
- [ ] Failed transactions leave no partial tree or sync state.
- [ ] Lazy content still hydrates after an ancestor move.
- [ ] V1 IndexedDB conformance remains green.
- [ ] `pnpm format`, `pnpm typecheck`, `pnpm lint:fix`, and `pnpm test` pass.

## Out of scope

- Production backfill and protocol default selection.
- Native filesystem.
- Final conflict policy.
- Ignore-list projection and boundary transitions; the dedicated reconciliation task owns them.
- Removing v1 object stores.
