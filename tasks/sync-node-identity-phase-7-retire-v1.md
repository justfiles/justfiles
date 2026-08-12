---
project: packages/sync
status: planned
source_issue: 469
---

# sync v2 phase 7: retire path sync and enforce move and fanout bounds

## Parent

[sync node identity epic](./sync-node-identity.md)

## Type

AFK cleanup, migration-finalization, and performance-regression slice. Destructive removal is gated by the conditions below.

## Blocked by

- [phase 5: migration](./sync-node-identity-phase-5-migration.md) for safe deployed-client cutover.
- [phase 6: native filesystem](./sync-node-identity-phase-6-native-fs.md) for the final supported native adapter.

## Removal gate

Do not start destructive removal until all supported clients negotiate v2 and the project owner confirms that protocol-v1 rollback is no longer required. It is acceptable to implement non-destructive checks and performance tests before that confirmation.

## Context for a fresh agent

Path v1 currently owns:

- `PathChange` put/delete wire records;
- per-path versions and path tombstones;
- path journals and path snapshot stores;
- subtree enumeration in `pathSyncObserver.move`;
- `/fs/path/*` routes and path cursors;
- v1 fields in sync state;
- v1 IndexedDB object stores and SQLite tables.

V2 must already be the active, migrated production path before these are removed.

Read all phase tasks in [sync node identity epic](./sync-node-identity.md) and confirm their acceptance criteria remain green. Read current migration and retention code before deleting it; path journal floors and tombstone snapshots contain correctness rules that v2 must retain by node identity.

## What to build

Remove protocol v1 and its compatibility bridge. Make node-addressed v2 the only sync engine.

Remove or replace:

- path-only wire schemas and replica roles that have no remaining consumer;
- path journal, per-path version, path tombstone, path snapshot, and v1 cursor persistence;
- v1 HTTP endpoints and client methods;
- dual-recording compatibility observer;
- v1 IndexedDB stores in a versioned upgrade;
- v1 SQLite state through safe migrations or final schema cleanup;
- roadmap comments and exports that describe path sync as current behavior.

Keep reusable canonical path utilities only where the filesystem, native scan, ignores, or public path interface still needs them.

Add permanent operation-count regression tests for move and fanout. Do not use wall-clock thresholds as correctness tests.

## Required final behavior

- One logical node has one sync ID across every replica and one local inode mapping per replica.
- Create, update, move, and delete are the only synchronization mutations.
- Moving or renaming one node between visible paths appends one source mutation and one accepted server mutation.
- Each receiving replica applies one visible-to-visible move. That work is O(number of replicas), not O(subtree nodes x replicas).
- A visible-to-visible move never enumerates descendants, creates descendant tombstones, rewrites descendant sync state, or transfers content.
- Recursive delete remains child-first O(N).
- Snapshot and delta cursors operate on node state and preserve the frozen-high-water guarantee.
- Node tombstone retention preserves stale-client correctness. If collection removes the last mutation needed by a lagging cursor, the journal floor forces authoritative rebootstrap.
- Generation, lineage, reset, ignored/private paths, lazy content, and blob GC continue to work.
- Existing v1 data can be collected only after successful v2 migration state proves it is no longer the sole copy of needed identity or cursor information.

## Visibility boundary requirements

Permanent performance assertions must distinguish ordinary moves from visibility-boundary transitions.

- visible -> visible remains one move with no descendant work.
- ignored -> ignored produces no mutation, journal row, or blob work.
- ignored -> visible and visible -> ignored use `publishTree` and `unpublishTree`. They are O(N) by design because the projection gains or loses N nodes.
- A boundary operation can use paged payloads, but publication is atomic and resumable. Tests count nodes and pages; they do not claim O(1).
- Keep built-in and host-ignore tests as permanent security tests after v1 removal.

### Additional RED/GREEN cycle: permanent visibility boundary

**RED:** Add backend-independent tests for all four transitions, fresh republish IDs, private-byte survival, inbound rejection, nested ancestor shielding, crash-safe publication, and absence of ignored data from all metadata and blob endpoints.

**GREEN:** Remove any v2 path that bypasses the shared projection planner. Keep canonical path utilities used for visibility.

### Added acceptance criteria

- [ ] Every O(1) move test uses visible source and destination paths.
- [ ] Boundary fanout has no duplicate node work.
- [ ] Removing path v1 does not remove path-aware visibility evaluation.

## RED/GREEN TDD specification

### Cycle 1: permanent move operation bound

**RED:** Add a backend-independent test that creates subtrees with 0, 1, 100, and 4,000 descendants, moves the root between visible paths, and asserts for every size:

- one source node-journal row;
- one outgoing mutation;
- one server accepted row;
- one receiving apply call;
- zero content uploads;
- unchanged descendant sync IDs and revisions.

**GREEN:** Remove any remaining v2 descendant enumeration, rewriting, or duplicate recording.

### Cycle 2: replica fanout bound

**RED:** Sync the same 4,000-descendant move to 1, 2, and 5 receiving replicas. Assert total delivered move mutations equals the number of receivers, not subtree size times receivers.

**GREEN:** Ensure server delta and echo filtering serve one accepted move per receiver cursor.

### Cycle 3: node tombstone retention and floor

**RED:** Delete nodes, advance one client, leave another behind, compact superseded rows, then age final tombstones beyond retention. Assert the current client resumes cheaply and the lagging client receives a typed rebootstrap requirement rather than silently missing deletes.

**GREEN:** Port the path journal's correctness rules to node IDs and node cursors before deleting v1 retention code.

### Cycle 4: authoritative rebootstrap after collection

**RED:** Force a lagging client below the node journal floor while it holds deleted and moved local state. Rebootstrap it and assert final node identity, tree, tombstones, and content converge without resurrection.

**GREEN:** Complete node snapshot plus tombstone behavior and cursor reset.

### Cycle 5: remove v1 transport

**RED:** Change the public transport/conformance expectation so only v2 handshake, snapshot, delta, mutation, and blob routes exist. Confirm old routes and client methods fail compilation or return the documented unsupported result.

**GREEN:** Delete v1 Hono routes, remote methods, schemas, and compatibility recording.

### Cycle 6: remove v1 persistence

**RED:** Upgrade a fully migrated SQLite and IndexedDB fixture containing old v1 tables/stores. Assert v2 tree, IDs, content, cursors, and tombstones remain correct after old state is collected.

**GREEN:** Add safe final migrations and delete v1 store implementations.

### Cycle 7: delete dead path modules

**RED:** Add architecture checks that `packages/sync` no longer exports `PathChange`, `PathMutationStore`, `PathSnapshotStore`, path journal interfaces, or path protocol constructors. Assert `packages/fs` still has no sync imports.

**GREEN:** Remove dead interfaces, adapters, tests, comments, and exports. Keep only path utilities with real remaining consumers.

### Cycle 8: deterministic convergence regression

**RED:** Run seeded randomized create, update, move, delete, restart, retry, stale conflict, snapshot, and journal-prune scenarios across memory, SQLite, IndexedDB, and native adapters. Assert all replicas converge to the accepted server node tree and print the seed on failure.

**GREEN:** Fix only behavior exposed by reproducible seeds. Do not weaken invariants to accept corrupt states.

### Refactor only after GREEN

After removal tests pass, simplify names from experimental `v2` forms to the primary sync vocabulary. Keep compatibility aliases only if an external package still needs a deprecation period.

## Acceptance criteria

- [ ] The removal gate has explicit owner confirmation.
- [ ] Protocol v1 routes, wire records, cursor fields, observers, and persistence have no production consumer and are removed.
- [ ] Migrated SQLite and IndexedDB fixtures retain complete v2 state after v1 collection.
- [ ] A visible-to-visible move creates exactly one mutation at each journal and one delivery per receiving replica for all tested subtree sizes.
- [ ] A visible-to-visible move performs no descendant enumeration, state rewrite, or content transfer.
- [ ] Node tombstone collection and journal-floor rebootstrap are correct for stale clients.
- [ ] Seeded randomized convergence covers all supported adapters and is reproducible.
- [ ] Comments and docs describe node identity as the only current model.
- [ ] `packages/fs` stays sync-free.
- [ ] `pnpm format`, `pnpm typecheck`, `pnpm lint:fix`, and `pnpm test` pass.

## Out of scope

- Further optimization of recursive delete.
- A full three-tree planner.
- Hard links.
- Automatic user-facing conflict copies.
