---
project: packages/sync
status: done
---

# sync: add progressive storage capabilities and universal fallbacks

## Parent

[sync node identity epic](./sync-node-identity.md)

## Type

Foundational refactor and memory tracer bullet. It preserves the completed node
identity and snapshot behavior while putting the adapter seam in its final package.

## Blocked by

- [phase 1: memory reference](./sync-node-identity-phase-1-memory.md)
- [snapshot handoff](./sync-node-identity-snapshot-handoff.md)

## Blocks

- [phase 2: SQLite and HTTP](./sync-node-identity-phase-2-sqlite-http.md)
- [phase 3: IndexedDB](./sync-node-identity-phase-3-indexeddb.md)

## Context for a fresh agent

The completed memory implementation proves stable node IDs, compact moves, ordered
deltas, remote apply, and an atomic snapshot-to-delta handoff. Build on it; do not
replace it with a second sync engine.

The current assembly exposes two storage-specific top-level refinements:

- path v1 uses `JournaledStorage.sync`;
- node v2 uses `NodeStorage.nodeSync` and requires `caps.content` in
  `nodeSyncReplica()`.

That makes a backend author learn sync-owned types before the progressive storage
contract is visible, and the content requirement prevents graceful degradation.
This task changes the assembly boundary, not the proven node protocol.

Read:

- `packages/fs/storage.ts` for the minimal `Storage` contract and filesystem caps;
- `packages/fs/storage.shared.ts` for the transaction-scoped tree port and observer;
- `packages/sync/node.ts` for the shared node rules and current persistence seam;
- `packages/sync/node-snapshot.ts` for adapter-owned snapshot sessions;
- `packages/sync/storage/node-mem.ts` for the reference assembly;
- `packages/sync/replica.ts` and `synced.ts` for current path fallback behavior.

## Architectural decision

### One minimum, optional accelerators

`Storage` remains the only filesystem interface an author must implement. Every
capability is optional. The sync engine selects one strategy at construction and
does not scatter capability checks through the algorithm.

| Available capabilities | Required sync strategy |
| --- | --- |
| neither `sync` nor `content` | full-tree reconciliation; read ordinary inode blobs, calculate hashes, and transfer complete bytes |
| `content` only | full-tree reconciliation with hash lookup, deduplication, and missing-blob transfer |
| `sync` only | stable IDs, snapshots, and incremental deltas; serve and materialize bytes through ordinary `Storage` blob operations |
| both | stable IDs, incremental deltas, compact moves, direct hash lookup, deduplication, and the most efficient snapshots |

Capability absence may cost scans, hashing, byte copies, and retries. It must not
make sync unavailable. The storage-only guarantee is convergence through a full
reconciliation when writes eventually quiesce; it does not promise an atomic cut,
stable rename identity, incremental cursors, or O(1) moves.

When a capability is present, its contract is complete. Do not replace one optional
capability with a large bag of optional methods.

### Keep sync vocabulary out of `packages/fs`

Do not add `sync`, `SyncCapability`, node IDs, journals, revisions, snapshots, or
protocol imports to `packages/fs`.

`packages/sync` owns a structural refinement of the existing capability object:

```ts
import type { Storage, StorageCapabilities } from '@justfiles/fs/storage'

export type SyncCapableStorage = Storage & {
	readonly caps: StorageCapabilities & {
		readonly sync: SyncCapability
	}
}
```

At runtime the optional value is `storage.caps.sync`. At compile time only
`packages/sync` knows that extension. `packages/fs` continues to type and use its
own capabilities and harmlessly ignores the extra property. Use one small local
discovery helper in `packages/sync`; do not use module augmentation, an untyped
string registry, or a reverse dependency from fs to sync.

The current `Storage` interface does not need to become generic merely to permit
this structural extension. Add a generic capability parameter only if another real
package-owned extension later proves that it removes code.

### `sync` and `content` are independent

Rename the optional accelerator to `sync`, not `nodeSync`. Node addressing is an
internal implementation and wire concern.

`caps.sync` must not require `caps.content`. A content hash remains the wire
integrity and deduplication key, but hash-addressable local storage is only an
optimization:

- without `caps.content`, outbound code resolves the node to its local inode,
  reads `Storage.getBlob()`, and verifies the calculated hash before serving it;
- inbound code fetches required bytes before apply and materializes them with the
  inode update rather than publishing an unreadable hash reference;
- lazy content is unavailable without a durable hash-addressed store, so the
  fallback is eager;
- a snapshot session copies or otherwise retains every advertised byte sequence
  until close or expiry. If it cannot establish that cut, opening fails before a
  session token is returned.

Do not add hash-to-inode lookup to `Storage`. The sync state already knows node to
local-inode bindings; a scan is an acceptable fallback when no content index exists.

### Share sync rules over internal adapter primitives

Backend authors must not reimplement mutation folding, apply ordering, journal
compaction, snapshot paging, or delta handoff. `SyncCapability` is assembled by
shared code from a small adapter, rather than hand-written independently by memory,
SQLite, IndexedDB, and PostgreSQL.

Start from the seams already proven by memory:

- transaction-scoped `TreePort` for filesystem reads and writes;
- sync-owned node state and ordered-journal persistence;
- mutation observation inside the owning write transaction;
- one adapter-owned snapshot cut containing live state, content lifetime, and the
  journal high-water.

Keep these primitives internal to `packages/sync` and its adapter entry points.
The package-root author surface should expose `SyncCapability`, the capability
refinement, and a construction helper—not `NodeStore`, `TreePort`,
`NodeSnapshotSessions`, or database tables.

Do not freeze a broad transaction abstraction from memory alone. Refine the current
internal seam only where SQLite genuinely requires it in phase 2; IndexedDB in
phase 3 is the third implementation that validates it. PostgreSQL should later be
able to implement the same transactional primitives without copying sync policy.

## What to build

1. Move the completed memory node assembly from top-level `nodeSync` to
   `caps.sync`, using a type owned by `packages/sync`.
2. Put the current node store, observer, apply driver, and snapshot sessions behind
   one shared capability-construction path. Preserve their behavior and tests.
3. Replace direct `caps.content` requirements with one content strategy selected at
   replica construction: addressed content when present, ordinary inode blobs when
   absent.
4. Add a storage-only full-scan strategy for a backend with no `caps.sync`. It may
   represent a rename as delete plus create and may retry a changing scan.
5. Select the four combinations in one place. Keep the production protocol-v1/v2
   rollout gates unchanged; this task proves the strategy boundary in memory and
   does not prematurely switch deployed clients.
6. Retain the existing node wire types during the compatibility window. Renaming
   internal `Node*` types is cleanup only after v2 becomes the sole protocol.

The full-scan path in this task needs to prove fresh bootstrap and quiescent
create/update/move/delete convergence. Non-empty conflict reconciliation, ignore
policy transitions, and authoritative replacement remain in
[ignore-policy reconciliation](./sync-node-identity-ignore-policy-reconciliation.md).

## RED/GREEN TDD specification

### Cycle 1: capability ownership without behavior change

**RED:** Run the completed memory node conformance suite through a storage whose
optimized sync entry is discoverable only at `caps.sync`. Assert that no exported
`NodeStorage.nodeSync` refinement is required.

**GREEN:** Add the sync-owned structural capability type and move the current memory
assembly behind it. Do not edit the node mutation rules.

### Cycle 2: one shared construction path

**RED:** Run create, update, move, delete, retry, and paged snapshot handoff through
the default memory store and an injected node-state store. Assert identical public
behavior and snapshot content retention.

**GREEN:** Assemble the observer, state store, apply driver, and snapshot owner once.
Remove only obsolete duplicate construction paths after the tests are green.

### Cycle 3: `sync` without `content`

**RED:** Hide `caps.content` before constructing the replica, sync regular-file
create and update, run a paged snapshot while old content is replaced and collected,
and assert convergence plus readable advertised bytes. Assert lazy hydration is not
selected.

**GREEN:** Add the ordinary-blob content strategy, eager prefetch/materialization,
hash verification, and session-owned byte retention. Do not add a content-store
requirement to `SyncCapability`.

### Cycle 4: `content` without `sync`

**RED:** Hide `caps.sync`, retain `caps.content`, and converge a quiescent memory tree
through full scanning. Assert missing hashes are transferred once and a directory
rename is allowed to fan out.

**GREEN:** Add the scanning strategy and use the content capability only for lookup
and deduplication.

### Cycle 5: neither capability

**RED:** Expose only the base `Storage` surface. Bootstrap an empty peer, then
converge quiescent create, update, rename, and delete work. Assert bytes are read and
written through ordinary blob operations and no capability error is thrown.

**GREEN:** Calculate hashes in shared sync code, retain per-session hash-to-bytes
state, and apply complete bytes. Retry rather than accepting a torn scan.

### Cycle 6: one strategy selector

**RED:** Exercise all four capability combinations through the same sync entry point
and assert which strategy is selected. Capability checks outside that boundary fail
an architecture test.

**GREEN:** Centralize selection and pass complete strategy objects into the shared
engine.

### Refactor only after GREEN

Keep `SyncCapability` small and capability discovery local. Do not export the
internal node persistence or snapshot lifecycle merely to make tests convenient.

## Acceptance criteria

- [x] Implementing only `Storage` is sufficient for quiescent full-scan sync.
- [x] `caps.content` and `caps.sync` independently improve the selected strategy.
- [x] Every one of the four capability combinations passes public memory behavior.
- [x] Missing `caps.content` never throws merely because sync needs file bytes.
- [x] Missing `caps.sync` selects reconciliation instead of rejecting the backend.
- [x] `caps.sync` preserves the completed stable-ID, compact-move, retry, and
  snapshot-handoff behavior.
- [x] Shared sync rules are not copied into the memory adapter.
- [x] `packages/fs` contains no `sync` capability declaration, sync import, node ID,
  journal, revision, snapshot-session, or protocol concept.
- [x] The only minimum backend interface remains `Storage`.
- [x] `pnpm format`, `pnpm typecheck`, `pnpm lint:fix`, and `pnpm test` pass.

## Out of scope

- SQLite, HTTP, and IndexedDB persistence.
- PostgreSQL implementation; it is a future consumer of the validated database
  adapter seam.
- Final server conflict policy.
- Production v1/v2 cutover.
- Concurrent non-empty conflict resolution and ignore-policy transitions; the
  full-scan fallback only supports authoritative quiescent reconciliation.
