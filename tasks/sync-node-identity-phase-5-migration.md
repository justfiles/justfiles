---
project: packages/sync
status: planned
source_issue: 467
---

# sync v2 phase 5: backfill identities and run a safe v1/v2 compatibility window

## Parent

[sync node identity epic](./sync-node-identity.md)

## Type

AFK migration and rollout slice. It must preserve user data and old-client convergence.

## Blocked by

- [phase 2: SQLite and HTTP](./sync-node-identity-phase-2-sqlite-http.md)
- [phase 3: IndexedDB](./sync-node-identity-phase-3-indexeddb.md)
- [phase 4: authority and conflicts](./sync-node-identity-phase-4-authority-conflicts.md)
- [ignore-policy reconciliation](./sync-node-identity-ignore-policy-reconciliation.md)

## Context for a fresh agent

Protocol v1 addresses paths. Protocol v2 addresses stable node IDs. Their cursors, tombstones, and identity meanings are not interchangeable.

Read:

- `packages/sync/synced.ts` for bootstrap, cursor, lineage, and reset behavior.
- `packages/sync/replica.ts` for snapshot high-water and journal floors.
- `packages/core/src/reset.ts` and migrations `0004`-`0009` for generation, lineage, reset, and tombstone retention.
- The v2 HTTP and adapters from phases 1-4.

This task owns migration of existing deployed data. Do not remove v1 here.

## What to build

Add:

1. server-side backfill of stable IDs for an existing live inode tree;
2. a compatibility bridge that keeps v1 and v2 clients convergent;
3. protocol negotiation and separate cursor state;
4. a safe per-client cold-start cutover from v1 to v2;
5. resumable migration state and rollout controls.

## Complete migration behavior

### Server backfill

- The server binds the well-known root sync ID to its existing root inode.
- It assigns one new sync ID to every existing live inode and stores its current `parentId + name` state.
- It does not change local inode IDs, dirents, metadata, content hashes, paths, blobs, or user xattrs.
- It is idempotent and resumable. Re-running it preserves every already assigned sync ID.
- IDs become visible only with a complete, internally consistent node snapshot and delta high-water.
- Pre-v2 path tombstones do not invent node IDs. The first v2 bootstrap uses the live server tree as authority for objects that predate identity.
- Completing backfill advances or records a v2 identity epoch. V1 and v2 cursors remain separate.

### Compatibility bridge

During the compatibility window, the server records both protocols from one committed filesystem mutation.

- A v2 create, update, move, or delete produces the v1 path changes required for old clients.
- A v2 move can still expand to `2N` only in the v1 compatibility journal. Its v2 journal remains one row.
- A v1 create or update is assigned or retains a server-side sync ID and produces v2 state.
- V1 does not carry identity. Therefore a v1-authored directory rename can appear to v2 as child-first deletes followed by parent-first creates with new sync IDs. This legacy behavior is permitted only during compatibility and must be documented in tests.
- A v1 delete produces v2 tombstones for the server node IDs that existed before deletion.
- Echo suppression is protocol-aware. A pulled v1 operation cannot bounce through v2 and back, and the reverse cannot bounce through v1 and back.
- One failed observer rolls back both protocol records and the filesystem mutation on database-owned backends.

### Negotiation

- Handshake reports supported protocol versions and the v2 identity epoch.
- A client selects exactly one protocol for a sync cycle.
- V1 path cursors and v2 node cursors use different persisted fields and cannot be copied or compared.
- A client with unsupported v2 stays on v1.
- A server can disable new v2 client activation without disabling v2 bridge recording.

### Client cutover

Perform cutover before the synced volume is returned to application callers, so no new local writes race the identity transition.

1. If the server is unavailable, keep the client on v1 and defer cutover. Offline use must continue.
2. On a connected cold start, complete a normal v1 push and pull until both sides are drained and generation/lineage are stable.
3. Request the server's consistent v2 snapshot and high-water.
4. Bind received sync IDs to matching existing local inodes by canonical path and type. Reuse content already present by hash.
5. Materialize remote-only nodes and remove or reconcile local nodes absent from the authoritative post-drain snapshot, using the current ignore-list rules.
6. Commit the complete mapping, v2 cursor, identity epoch, and selected protocol atomically in the client's sync store.
7. Only then expose the volume and record new mutations through v2.
8. Keep v1 state until rollback policy permits its collection in phase 7.

Because v1 is fully drained before the application receives the volume, local unsynced work is first published to the server and receives server IDs. No local work is silently discarded.

### Crash recovery

- Before the final client commit, a crash restarts on v1 and retries cutover.
- After the final commit, a crash restarts on v2 with its committed v2 cursor and mappings.
- A partial server backfill resumes without changing assigned IDs.
- A lineage or identity-epoch mismatch forces a new authoritative v2 bootstrap. It cannot reuse an unrelated cursor.

## Visibility boundary requirements

Migration and the v1/v2 bridge must preserve the current visibility boundary.

- Server backfill and client binding use each replica's current ignore list. Skipped local nodes get no shared IDs.
- If an old or corrupt fixture contains v1 tombstones or journal rows for ignored paths, do not translate them to v2. Remove them without publication.
- The bridge expands `publishTree` to parent-first v1 puts and `unpublishTree` to child-first v1 deletes. It never emits the new ignored destination.
- Classify a v1-authored boundary move from both old and new paths. Translate it to publish, unpublish, or no-op, not an ordinary move.
- Cutover and reset preserve each replica's ignored bytes and never bind them to remote IDs.

### Additional RED/GREEN cycle: ignored-path migration fixture

**RED:** Migrate a fixture with visible files, independent client/server ignored trees, sync-engine state, caller-ignored descendants, and pending v1 boundary changes. Assert visible convergence, no ignored-path ID or wire record, correct bridge expansion, and local-byte survival at every crash point.

**GREEN:** Apply the shared projection classifier during backfill, bridge, cutover, reset, and recovery.

### Added acceptance criteria

- [ ] Mixed v1/v2 operation never weakens either endpoint's ignore list.
- [ ] No migration snapshot, bridge row, or recovery log discloses an ignored path or hash.

## RED/GREEN TDD specification

### Cycle 1: backfill does not change the filesystem

**RED:** Seed an existing SQLite tree with nested files, metadata, xattrs, and content. Run backfill twice. Assert through public volume reads that nothing changed and through the node-sync interface that every live node has one stable ID after both runs.

**GREEN:** Add resumable root and live-node backfill.

### Cycle 2: v2 mutation reaches a v1 client

**RED:** Keep one client on v1 and one on v2. Create and move a 100-node directory from v2. Assert the v1 client converges by path, the v2 server journal has one move, and only the compatibility v1 journal fans out.

**GREEN:** Compose both observers inside the server transaction with protocol-specific origin suppression.

### Cycle 3: v1 mutation reaches a v2 client

**RED:** Create, update, and delete from v1 and assert the v2 client sees the correct accepted nodes and tombstones. Rename a directory from v1 and assert the documented legacy delete/create identity behavior without duplicate live names.

**GREEN:** Translate committed v1 filesystem effects into server-owned v2 identities and mutations.

### Cycle 4: offline client defers cutover

**RED:** Start an existing v1 client without the server. Assert its files remain usable, it stays v1, and no partial v2 mapping or cursor is committed.

**GREEN:** Gate cutover on a successful v2 handshake and leave offline startup unchanged.

### Cycle 5: unsynced v1 work survives cutover

**RED:** Make offline v1 creates, updates, moves, and deletes. Start connected migration. Assert v1 drains first, server assigns identities, client commits matching identities, and a fresh v2 client converges to all work.

**GREEN:** Implement cold-start drain, snapshot bind, and atomic protocol selection.

### Cycle 6: existing content is not downloaded again

**RED:** Cut over a client with a large fully-synced tree and count blob reads. Assert metadata snapshot and ID binding reuse matching local content hashes with zero blob downloads.

**GREEN:** Bind existing local inodes and reuse the content store when hashes match.

### Cycle 7: crash at every migration boundary

**RED:** Inject a crash after backfill pages, after v1 drain, during v2 snapshot, during local binding, immediately before final commit, and immediately after it. Restart each case and assert eventual convergence with no duplicate IDs or lost files.

**GREEN:** Persist resumable server progress and make the client final switch one atomic sync-store commit.

### Cycle 8: cursor and lineage isolation

**RED:** Attempt to use a v1 cursor as v2, reuse a v2 cursor against a different identity epoch, and reset the server during migration. Assert typed rebootstrap behavior rather than partial deltas.

**GREEN:** Add protocol-tagged cursor state and identity-epoch fencing.

### Cycle 9: mixed-version soak

**RED:** Run deterministic randomized operations from one v1 client and two v2 clients, including restarts and reordered sync cycles. Assert all visible trees and content converge after draining. Assert v2-authored moves remain one row in every v2 journal.

**GREEN:** Fix only behavior exposed by the deterministic scenario. Print the seed on failure.

## Acceptance criteria

- [ ] Existing server trees receive stable IDs without user-visible mutation or content transfer.
- [ ] Backfill and client cutover are idempotent, resumable, and crash-safe.
- [ ] Offline clients continue on v1 until they can cut over safely.
- [ ] Unsynced v1 work is drained and preserved before v2 activation.
- [ ] Mixed v1/v2 clients converge with documented legacy identity limits.
- [ ] V2-authored moves stay one row in v2 even when the v1 bridge fans out.
- [ ] Protocol cursors and identity epochs cannot be confused.
- [ ] No blob is downloaded when existing local content already matches by hash.
- [ ] Production v2 activation has a server-side rollout switch.
- [ ] `pnpm format`, `pnpm typecheck`, `pnpm lint:fix`, and `pnpm test` pass.

## Out of scope

- Removing v1 state or code.
- Native filesystem migration.
- Preserving stable identity for a rename authored by a protocol-v1 client that never sent identity.
