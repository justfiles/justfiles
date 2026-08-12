---
project: packages/sync
status: planned
---

# sync node identity: reconcile ignore-list changes on launch

## Parent

[sync node identity epic](./sync-node-identity.md)

## Type

AFK vertical slice through the shared sync contract, memory reference, SQLite server, HTTP subscription, IndexedDB client, startup lifecycle, and public integration tests.

## Blocked by

- [phase 1: memory reference](./sync-node-identity-phase-1-memory.md) for node identity and fixed-policy projection behavior.
- [phase 2: SQLite and HTTP](./sync-node-identity-phase-2-sqlite-http.md) for server persistence and filtered transport.
- [phase 3: IndexedDB](./sync-node-identity-phase-3-indexeddb.md) for durable browser state.
- [phase 4: authority and conflicts](./sync-node-identity-phase-4-authority-conflicts.md) for remote-authoritative conflict rules and idempotent operations.

## Context for a fresh agent

The current path engine accepts an opaque `ignore?: (path: string) => boolean` when `synced()` starts. It filters journal rows after reading them and can advance the cursor past a filtered change. It does not persist the policy, detect a policy change, remove newly visible gaps, or republish nodes that become visible.

Protocol v2 already requires path-aware filtering around a node-addressed tree. This task adds the missing lifecycle when that filter changes between application releases or volume launches.

Read:

- `packages/sync/synced.ts`: startup, handshake, cursor persistence, reset, and the current `ignore` input.
- `packages/sync/replica.ts`: `syncIgnore`, path filtering, `shieldsIgnored`, `SyncState`, snapshot high-water, and journal floors.
- `packages/sync/synced.test.ts`: destructive reconcile and caller-ignore behavior.
- `packages/sync/sync-test-harness.ts`: client/server conformance setup.
- The node contract and adapters from the blocking tasks.

Keep the public surface small. The application supplies paths. Sync owns policy identity, subscription filtering, reconciliation, persistence, recovery, and best-effort conflict handling.

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
