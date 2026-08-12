---
project: packages/sync
status: planned
---

# sync node identity: implement projections and reconcile ignore-list changes

## Parent

[sync node identity epic](./sync-node-identity.md)

## Type

AFK vertical slice through the shared sync contract, memory reference, SQLite server, HTTP subscription, IndexedDB client, startup lifecycle, and public integration tests.

## Blocked by

- [phase 1: memory reference](./sync-node-identity-phase-1-memory.md) for node identity and constant-cost moves over a complete tree.
- [snapshot handoff](./sync-node-identity-snapshot-handoff.md) for atomic current-state bootstrap sessions.
- [phase 2: SQLite and HTTP](./sync-node-identity-phase-2-sqlite-http.md) for server persistence and HTTP transport.
- [phase 3: IndexedDB](./sync-node-identity-phase-3-indexeddb.md) for durable browser state.
- [phase 4: authority and conflicts](./sync-node-identity-phase-4-authority-conflicts.md) for remote-authoritative conflict rules and idempotent operations.

## Context for a fresh agent

The current path engine accepts an opaque `ignore?: (path: string) => boolean` when `synced()` starts. It filters journal rows after reading them and can advance the cursor past a filtered change. It does not persist the policy, detect a policy change, remove newly visible gaps, or republish nodes that become visible.

Phase 1 deliberately synchronizes the complete node tree. This task introduces the
projection model itself as well as the lifecycle when its policy changes. Do not add
projection filtering incrementally to the phase-1 journal or applier: the fixed-policy
and policy-change cases share the same state model, cursor fencing, and reconciliation
rules and must land together.

Read:

- `packages/sync/synced.ts`: startup, handshake, cursor persistence, reset, and the current `ignore` input.
- `packages/sync/replica.ts`: `syncIgnore`, path filtering, `shieldsIgnored`, `SyncState`, snapshot high-water, and journal floors.
- `packages/sync/synced.test.ts`: destructive reconcile and caller-ignore behavior.
- `packages/sync/sync-test-harness.ts`: client/server conformance setup.
- The node contract and adapters from the blocking tasks.

Keep the public surface small. The application supplies paths. Sync owns policy identity, subscription filtering, reconciliation, persistence, recovery, and best-effort conflict handling.

## Findings from the phase-1 prototype

An earlier prototype put fixed-policy projection handling directly in the memory
node recorder, applier, snapshot, relay, and blob planner. Repeated review findings
showed that projection is not a row filter around node sync; it is a separate
materialization state machine. Preserve these lessons in the implementation:

- Separate authoritative logical node state from local materialization and from
  local-only filesystem entries. A nullable inode cannot safely encode tombstoned,
  hidden, blocked-by-local-data, and absent-with-an-unmaterialized-parent states.
- Model leaving a projection separately from logical deletion. A `delete` tombstones
  the shared ID and cannot express a node that is merely detached from one
  subscription and may later return with the same identity.
- Treat a snapshot as current state, not as a stream of historical `create`
  mutations when reconciling a non-empty replica. Reconciliation must explicitly
  remove stale materializations, relocate known IDs, and preserve protected local
  entries while still accepting newer authoritative state.
- Never relay an already-filtered local journal as an authoritative stream for a
  third replica. The server must produce policy-bound snapshots and deltas for the
  subscription; filtering a move by its current path loses the withdrawal, while
  forwarding it can disclose the hidden destination.
- Apply the same transition planner to local authorship, remote apply, snapshot
  recovery, delta recovery, blob planning, and ancestor moves. Implementing those
  paths independently produced mirrored enter/leave and root/descendant bugs.
- Bind every cursor and frozen snapshot to the effective policy hash. A presence-only
  bootstrap cannot repair previously materialized nodes that disappeared from the
  new projection without a reconciliation phase.
- Accept authoritative node state even when a local tree write is deliberately
  refused to preserve local-only data. The materialization result and cursor advance
  must not leave the logical node at a stale location.
- Make compound attach/detach/move work transactional before claiming atomic
  projection changes. The memory adapter needs an explicit staged transaction if it
  remains the reference for this behavior; primitive-by-primitive apply is not
  sufficient.
- Current-state snapshots only bootstrap unknown IDs until this task lands. Accepting
  a higher-revision snapshot create for a known node turns non-empty rebootstrap into
  topology reconciliation:
  relaying a partial page can place a replacement directory after retained children
  or before its new parent. Add that behavior only with the later reconciliation
  planner, which can re-emit the affected subtree in parent-first order.
- A frozen snapshot must own one atomic state/content cut and keep every referenced
  blob readable until the receiver closes or expires the session. Freezing node
  metadata and pinning blobs afterward has a race with mutation and content GC.
  Keeping a bounded page cache is also insufficient: eviction can invalidate a live
  cursor, and content for the final page is fetched after that page is returned. The
  [snapshot handoff task](./sync-node-identity-snapshot-handoff.md) owns explicit
  session lifetime, release, and expiry without adding application-facing surface.
- Compact the mutation journal by node before content GC can expose an obsolete hash
  on a page by itself. A delete supersedes all earlier mutations for that node. A
  newer update supersedes older updates but must refresh a retained create for
  cursors that predate the node. Journal only accepted mutations, or a stale retry
  can replace the retained current state.
- Normalize policy paths consistently, but do not assume one normalized spelling
  identifies one filesystem entry. Filesystems can contain multiple siblings whose
  names normalize alike, so every matching entry must be classified. Authority-side
  node names should be validated independently.

The implementation should introduce explicit vocabulary for at least logical state,
materialization state, and projection attach/detach. The exact stored shape remains
an adapter decision; avoid growing `NodeState.localIno` into another implicit union.

## Public behavior

Replace the v2 predicate input with one serializable list:

```ts
type SyncOptions = {
	ignore?: readonly string[]
}
```

Version 1 supports canonical absolute roots only:

- `/private` matches the node at `/private` and every descendant.
- `/private/token` can match one file or a subtree if it is a directory.
- Matching is segment-aware. `/private` does not match `/privateer`.
- Normalize duplicate entries, trailing slashes, Unicode, and order before hashing.
- Reject relative paths, `.` or `..` segments, NUL, and the root `/`.
- Do not add glob syntax in this task. A later task can version the policy grammar if actual use requires it.

The sync engine excludes its own state without adding that path to the public list. `packages/sync` must not contain `/private`, credentials, accounts, or another product path.

## One-list semantics

The list is per replica and symmetric:

- do not publish matching local nodes;
- do not materialize matching remote nodes;
- do not expose matching nodes, tombstones, metadata, names, hashes, or blobs through that replica;
- preserve local matching bytes during ordinary sync, reset, bootstrap, and policy changes;
- treat same-path ignored trees on different replicas as independent.

The list is non-destructive policy. Changing it does not authorize deletion of another replica's independent bytes.

For one client/server connection, the effective list is:

```text
normalize(server ignore union client ignore)
```

The client sends its normalized list and hash when it opens the v2 subscription. The server applies the union before snapshot and delta serialization and before accepting mutations. It returns:

```ts
type IgnoreSubscriptionPolicy = {
	effectiveIgnore: readonly string[]
	effectiveHash: string
	identityEpoch: string
}
```

The client normalizes `effectiveIgnore`, recalculates `effectiveHash`, and verifies that every client root is present before it accepts a cursor. It uses the effective list for reconciliation and for local filtering in both directions. A mismatch is a typed protocol error and does not advance local state.

A client can add exclusions for its connection but cannot weaken the server list. The client still filters received data as a second enforcement point.

## Persisted state

Sync calculates the hash. The caller does not supply a policy version.

Persist at least:

```ts
type IgnorePolicyState = {
	effectiveIgnore: readonly string[]
	localHash: string
	effectiveHash: string
	remoteIdentityEpoch: string
	reconcile?: {
		operationId: string
		fromHash?: string
		toHash: string
		phase: 'snapshot' | 'local' | 'remote' | 'commit'
		cursor?: string
	}
}
```

The stored shape can differ. It must preserve these observable guarantees:

- the same normalized list has the same hash on every runtime;
- restart retains the exact effective roots needed to classify paths without asking the application to know the server list;
- a cursor is valid only for the effective policy hash that created it;
- restart resumes one reconciliation operation instead of starting a competing one;
- the new hash becomes active only after the new projection and cursor commit.

## Launch behavior

Before normal push and pull:

1. Normalize and hash the local list.
2. Open the remote subscription and receive the normalized effective list, effective hash, and identity epoch.
3. Verify the effective list and hash, then compare them with persisted sync state.
4. If they match, use the existing cursors without a tree scan.
5. If either differs or no prior state exists, freeze a filtered remote snapshot and pause normal push and pull.
6. Compare local materialization, local node mappings, and the filtered remote snapshot.
7. Apply the best-effort rules below in resumable pages.
8. Atomically commit the effective list, effective hash, identity epoch, and new cursor.
9. Resume normal sync.

`localFirst` can still return a usable local volume, but status remains `syncing` until reconciliation completes. Writes during reconciliation remain journaled and are processed after the new cursor commits. They cannot bypass the new list.

## Rolling deployment expectations

Ignore-list changes are infrequent deployment configuration changes. Do not require every platform or installed client to update at the same time.

- Each replica uses the list in its installed release. It reconciles only when that replica next opens with a different normalized hash.
- During a mixed release, different clients can have different effective lists and filtered cursors. This is supported connection behavior, not an error.
- A newly ignored path can remain visible on the server and on clients that still use the old list. An updated client must still preserve its ignored local bytes and must not receive that path.
- A server-list update hides the path from every later v2 subscription because the server list is part of every connection union. It does not require immediate physical cleanup.
- After clients adopt the same policy and reconnect, ordinary sync can converge the shared projection.

This task provides best-effort damage control. It does not promise an atomic account-wide policy switch, simultaneous visibility across mixed releases, reconstruction of bytes that an older client already overwrote, or a lossless three-way merge. Add a separate versioned rollout protocol only if a future product requirement needs those guarantees.

## Best-effort reconciliation rules

### A path becomes ignored

- Keep the local node and bytes.
- Stop publishing it and stop materializing remote changes for it.
- Remove or mask its live local sync binding so it cannot be mistaken for agreed state.
- Keep remote state only as non-materialized metadata if cursor correctness requires it.
- Do not emit a user delete solely because the policy changed.
- Do not delete the server's independent same-path node.

If both endpoints add the same root in a deployment, both keep their own local trees and the connection exposes neither.

### A path becomes visible

- Remote only: materialize it with the remote sync IDs.
- Local only: publish it with fresh sync IDs.
- Both with the same type and content hash: bind the local node to the remote IDs without content transfer.
- Both with different content or incompatible types: remote wins. Replace the local node after any required child-first removal. Data loss is accepted for this best-effort rule.
- A remote directory wins its colliding names. Non-colliding local children can publish afterward with fresh IDs.
- Never reactivate an old tombstoned ID or infer identity from path, size, time, or content hash alone.

### No previous policy state

Treat the current local tree and filtered remote snapshot as the only available facts. Do not try to reconstruct an unknown historical policy. Apply the same rules and record the first baseline hash.

## Filesystem moves versus policy changes

Do not combine these event types:

- A local filesystem move from visible to ignored still unpublishes the old visible subtree and keeps the new local ignored subtree.
- A local filesystem move from ignored to visible publishes fresh IDs.
- A policy change from visible to ignored masks and preserves each replica's current local subtree. It is not a filesystem delete or move.
- A policy change from ignored to visible runs the best-effort comparison above.

## Cursor and server behavior

- Include the effective policy hash in snapshot and delta cursor validation.
- A cursor from another hash returns a typed rebootstrap result. It never returns partial deltas under the new filter.
- A server-side list change affects all later subscriptions. A dormant account reconciles when its server volume next opens.
- Until physical reconciliation completes, server reads and writes use the new filter immediately. Hidden stale rows cannot cross the wire.
- A client-supplied list affects only that connection. It cannot purge server data or change another client's subscription.
- A direct caller cannot omit its declared list on later pages or reuse another subscription's cursor.

## RED/GREEN TDD specification

Complete one cycle before starting the next. Test through `synced()`, public volume reads, and the public replica transport. Do not assert private tables when observable behavior exists.

### Cycle 1: stable normalization and fast unchanged launch

**RED:** Launch twice with lists that differ only by order, duplicates, and trailing slashes. Assert the second launch reuses its cursors, performs no projection scan, transfers no blobs, and exposes the same tree. Add invalid roots and assert typed configuration errors before sync starts.

**GREEN:** Add the list input, canonical normalization, deterministic hash, validation, and persisted local hash.

### Cycle 2: connection union and cursor fencing

**RED:** Give the server `/server-private` and the client `/client-private`. Assert that the handshake returns both roots in canonical order with a matching hash and that neither subtree appears in the HTTP snapshot, delta, tombstone, or blob calls. Return a wrong hash and a list that omits the client root; assert a typed protocol error before any local state advances. Reuse a valid cursor with a different client list and assert a typed rebootstrap response.

**GREEN:** Add the subscription descriptor, returned effective union, client verification, filtered transport, and policy-bound cursor validation.

### Cycle 3: add an ignore root

**RED:** Complete a visible baseline sync for `/private`, then disconnect the client. Write different exact byte sequences to the same path on the offline client and server. Relaunch the client with `/private` ignored. Assert that each endpoint keeps its pre-launch byte sequence, no policy-generated delete or content transfer crosses the wire, no mapping claims agreed live state, and later changes on either side stay independent.

**GREEN:** Add visible-to-ignored startup masking and commit the new policy state after it completes.

### Cycle 4: remove an ignore root

**RED:** Cover remote-only, local-only, equal-content, different-content, type-collision, and non-colliding-child cases after `/private` becomes visible. Assert remote materialization, fresh-ID local publication, zero-byte equal binding, remote-wins replacement, and final convergence.

**GREEN:** Add ignored-to-visible comparison and the minimum remote-authoritative planner.

### Cycle 5: existing account without policy state

**RED:** Open legacy SQLite and IndexedDB fixtures that have files, node mappings, cursors, independent ignored trees, and no policy hash. Assert one full reconciliation, correct best-effort results, one committed baseline, and a fast second launch.

**GREEN:** Treat absent policy state as a resumable first baseline instead of a schema error.

### Cycle 6: crash and restart every phase

**RED:** Inject crashes during remote snapshot paging, local masking, remote materialization, local publication, and immediately before and after final state commit. Restart each case. Assert no ignored data leaks, no duplicate IDs or journal operations appear, and the final tree converges.

**GREEN:** Persist one operation ID and phased progress. Make each page and final commit idempotent.

### Cycle 7: writes during local-first reconciliation

**RED:** Return a local-first volume while reconciliation is running. Create visible and ignored files before it completes. Assert both remain usable immediately, only the visible file later publishes, and no write is lost behind the new cursor.

**GREEN:** Fence normal push and pull while retaining post-snapshot local journal work for the first new-policy cycle.

### Cycle 8: two clients with different lists

**RED:** Connect old-release and new-release clients with different ignore roots to one server. Keep the old client active while the new client reconciles. Assert independent filtered cursors, preservation of the new client's ignored bytes, normal convergence outside each list, and no policy change by one client alters the other client's remote projection. Do not require temporary account-wide visibility consistency.

**GREEN:** Scope subscription state and policy hashes to each connection or client cursor. Do not store one client list as global server policy.

### Cycle 9: server list changes

**RED:** Change the server list between launches while clients keep the same lists. Assert that every old effective cursor is fenced, matching paths are hidden before cleanup, dormant SQLite state reconciles on open, and a client cannot weaken the new server list.

**GREEN:** Include the server list in the effective hash and run the same internal reconciler when a server volume opens.

## Refactor only after GREEN

Keep one projection classifier and one policy normalizer in `packages/sync`. Memory, SQLite, IndexedDB, HTTP, and later native code must use the shared behavior rather than reimplementing pattern rules.

Do not expose reconciliation methods, policy versions, cursors, or operation IDs through `Volume`. The outside surface remains the one ignore list and the existing sync lifecycle.

## Acceptance criteria

- [ ] The only product-supplied concept is one `ignore: readonly string[]` list per replica.
- [ ] `packages/sync` contains no product-specific ignored path.
- [ ] The server and client union is enforced before all metadata and blob transport.
- [ ] The client receives, verifies, persists, and enforces the normalized effective list without exposing server-policy concepts to the application.
- [ ] An unchanged normalized list starts without a full scan.
- [ ] A changed list reconciles automatically before normal sync.
- [ ] Adding an ignore root preserves independent local and server bytes and emits no policy-generated user delete.
- [ ] Removing an ignore root follows the documented remote-wins best-effort rules.
- [ ] Existing accounts with no policy state establish a correct baseline.
- [ ] Cursors cannot cross effective policy hashes or identity epochs.
- [ ] Crash and restart cannot leak ignored data, lose post-snapshot writes, or duplicate IDs.
- [ ] Two clients can use different lists without changing each other's server view.
- [ ] Rolling deployment does not require simultaneous client updates or promise an atomic account-wide policy cutover.
- [ ] Memory, SQLite, and IndexedDB pass the same public conformance cases.
- [ ] `pnpm format`, `pnpm typecheck`, `pnpm lint:fix`, and `pnpm test` pass.

## Out of scope

- Glob, negation, regular-expression, or `.gitignore` grammar.
- A destructive global purge of an ignored path from every replica, backup, and version history.
- Conflict-copy UI or recovery of a local loser after remote-wins replacement.
- Lossless recovery from writes or overwrites performed by an older release before it adopts the new list.
- An atomic policy rollout across offline clients and different platform release schedules.
- Native watcher and sidecar integration; [phase 6](./sync-node-identity-phase-6-native-fs.md) applies this contract to native storage.
