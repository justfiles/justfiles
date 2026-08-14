---
project: packages/sync
status: done
---

# sync v2: add an atomic snapshot-to-delta handoff

## Parent

[sync node identity epic](./sync-node-identity.md)

## Type

AFK tracer-bullet implementation of an internal sync module. It adds no application
option and no `Volume` interface.

## Blocked by

[phase 1: memory reference](./sync-node-identity-phase-1-memory.md)

## Blocks

[phase 2: SQLite and HTTP](./sync-node-identity-phase-2-sqlite-http.md)

## Context for a fresh agent

Phase 1 can initialize an empty memory replica by replaying its retained journal from
the initial cursor. Durable adapters eventually prune journals, so they also need a
bounded current-state bootstrap followed by deltas after one frozen high-water.

An earlier phase-1 prototype added paged snapshots directly to `NodeSyncModule` and
cached snapshot blobs in the memory extension. Review exposed one ownership problem
behind several edge cases:

- `NodeStore` owned node state but not content lifetime.
- The content store owned blobs and garbage collection but not snapshot sessions.
- The replica served pages and blobs but did not own the atomic state/content cut.
- Freezing node metadata and pinning each hash afterward left an await-sized race in
  which a concurrent update or delete plus content GC removed an advertised blob.
- An optional blob reader made custom memory-extension composition silently bypass
  retention.
- A bounded cache could evict a live cursor, while retaining completed scans forever
  would leak memory. The final page cannot release its pins immediately because its
  blobs are fetched after the page response.

The snapshot session must own these facts together. Do not repair them with another
optional callback or by requiring callers to suspend garbage collection.

Read:

- `packages/sync/node.ts` for node mutations, journal replay, and the replica seam.
- `packages/sync/storage/node-mem.ts` for the phase-1 reference adapter.
- `packages/fs/storage.shared.ts` for the filesystem tree and content capabilities.
- `packages/sync/replica.ts` for the path-v1 snapshot high-water behavior, as
  behavioral context rather than an interface to copy.
- [phase 2: SQLite and HTTP](./sync-node-identity-phase-2-sqlite-http.md) so the seam
  can be implemented by a database transaction without memory-specific concepts.

## What to build

Add one internal snapshot-session module that opens a current-state bootstrap and
owns, for that session:

1. one consistent live-node view;
2. every content hash named by that view;
3. the delta high-water captured with the view;
4. parent-first paging state;
5. explicit close and bounded expiry.

Opening a session must either make every advertised blob readable for the session or
fail before returning a session token. A page must never advertise a hash that the
same session cannot serve.

The memory adapter is the reference implementation. Keep the seam internal to sync
and its storage adapters. The wire may carry an opaque session/page token, but the
application continues to supply no snapshot configuration or lifecycle calls.

Use the smallest lifecycle that is correct:

- the receiver closes after applying and fetching the final page;
- abandoned sessions expire after a documented bound;
- an expired or unknown token returns one typed restart result;
- resource limits reject or expire sessions deliberately rather than evicting a live
  session behind a valid cursor;
- restart and retry never resume from current state under an old token.

The memory reference admits four concurrent sessions and expires each after five
minutes without a page or blob access.

This task bootstraps an empty replica only. Applying a current-state snapshot over a
non-empty tree requires topology and absence reconciliation and remains in
[ignore-policy reconciliation](./sync-node-identity-ignore-policy-reconciliation.md).

## RED/GREEN TDD specification

Complete one cycle before starting the next. Test through the node replica and
filesystem behavior, not private cache contents.

### Cycle 1: frozen state and delta high-water

**RED:** Start a small-page bootstrap, mutate and rename nodes between pages, finish
the bootstrap, then replay deltas from the returned high-water. Assert an empty peer
converges with identical node IDs and no orphaned inode.

**GREEN:** Add one internal session with a parent-first frozen view and high-water.

### Cycle 2: atomic content retention

**RED:** Pause session creation and page delivery at every observable await. Update or
delete an unserved file and run content GC. Assert that session creation either fails
before returning a token or every advertised old hash remains fetchable through the
session.

**GREEN:** Move the state/content cut into one owning adapter operation. Do not freeze
state first and pin content afterward.

### Cycle 3: one adapter construction path

**RED:** Run the same mutation-plus-GC bootstrap through the default memory adapter
and one with an injected `NodeStore`. Assert the same behavior.

**GREEN:** Assemble state and content ownership in one internal memory-adapter factory.
Keep the exported phase-1 extension snapshot-free; do not add optional snapshot
parameters or a second construction path that can bypass retention.

### Cycle 4: release, expiry, and retry

**RED:** Assert final-page blobs remain readable until close, close releases them,
abandoned sessions expire, and a later page for a closed or expired token receives a
typed restart result. Run concurrent sessions at the configured resource bound and
assert a live token is never silently evicted.

**GREEN:** Add explicit close, bounded expiry, and deliberate admission behavior.

## Refactor only after GREEN

Keep session construction, paging, blob reads, and release behind one internal
module interface. Do not add snapshot methods to `Volume` or optional snapshot hooks
to the phase-1 `NodeSyncModule`.

## Acceptance criteria

- [x] An empty replica converges after paged snapshot plus delta replay during concurrent mutation.
- [x] Node state, content availability, and delta high-water come from one adapter-owned cut.
- [x] Every advertised content hash remains readable until session close or expiry.
- [x] Final-page content fetch completes before resources are released.
- [x] Unknown, closed, and expired sessions return one typed restart result.
- [x] Resource bounds never silently evict a live valid cursor.
- [x] Default and injected-store memory adapters pass the same public conformance tests.
- [x] No application option or `Volume` interface is added.
- [x] SQLite can implement the seam with its own transaction and retention mechanism.
- [x] `pnpm format`, `pnpm typecheck`, `pnpm lint:fix`, and `pnpm test` pass.

## Out of scope

- Applying snapshots over non-empty replicas.
- Ignore-policy filtering or policy-change reconciliation.
- SQLite, HTTP, IndexedDB, and native adapter implementations.
- Journal-pruning policy beyond handing off from the frozen high-water.
