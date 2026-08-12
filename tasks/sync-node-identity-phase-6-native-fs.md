---
project: packages/sync
status: planned
source_issue: 468
---

# sync v2 phase 6: map native filesystem nodes with a sidecar and reconciliation

## Parent

[sync node identity epic](./sync-node-identity.md)

## Type

AFK native-filesystem vertical slice. It uses observation and reconciliation, not database transaction interception.

## Blocked by

- [phase 1: memory reference](./sync-node-identity-phase-1-memory.md) for the v2 node contract.
- [phase 2: SQLite and HTTP](./sync-node-identity-phase-2-sqlite-http.md) for the remote v2 replica.
- [phase 4: authority and conflicts](./sync-node-identity-phase-4-authority-conflicts.md) for accepted mutation and conflict behavior.
- [ignore-policy reconciliation](./sync-node-identity-ignore-policy-reconciliation.md) for the persisted policy hash and launch-time transition behavior.

It does not need v1/v2 production cutover from [phase 5: migration](./sync-node-identity-phase-5-migration.md) to begin.

## Context for a fresh agent

Database-owned filesystems can commit tree state and sync state in one transaction. A real POSIX filesystem cannot join a rename or write with a sidecar database transaction. Native correctness therefore comes from observation plus repair.

Read:

- `packages/fs/storage.fs.ts`: native storage uses the string form of `stat.ino` as its local `Ino` and keeps an in-memory inode-to-path map.
- `packages/sync/replica.ts`: current `NativeIndex`, `FsWatcher`, and unimplemented `nativeChangeSource` scaffold.
- `packages/sync/path.ts`: comments under `NATIVE-FS SYNC (Path B: OBSERVE, don't intercept)`.
- The v2 node contract, snapshot, and HTTP replica from earlier phases.

Do not attach a transactional mutation observer to native storage. Finder, editors, git, and other processes can mutate the tree without using `Storage`.

## What to build

Replace or extend the path-based `NativeIndex` scaffold with a v2 native node sidecar that implements the shared node-sync roles.

Persist at least:

- sync ID;
- current local file identity key;
- parent sync ID and name;
- accepted node revision and tombstone state;
- hash cache keyed by stable observed file identity plus a content-change token that the adapter declares reliable;
- watcher or reconciliation cursor;
- pending local node mutations and their operation IDs.

Use a sidecar SQLite or another existing durable local store. Keep the sidecar outside the synchronized root or under an always-ignored location.

Define a small injectable native file-identity adapter. For Node/POSIX, form identity from enough `lstat` fields to avoid cross-device inode collision, such as device plus inode and an available creation discriminator. Do not use path as identity. Do not send this native key on the wire.

OS identity can be reused. If the adapter cannot prove continuity, treat the event as delete plus create with a new sync ID. Never use equal size, mtime, or content hash alone to claim that two paths are the same logical node.

## Complete behavior

### Local observation

- Initial scan walks the tree parent before child, assigns sync IDs to unknown nodes, and persists a consistent sidecar snapshot.
- Incremental watcher output is a set of candidate paths, not authoritative state.
- Reconciliation stats candidates and compares observed file identity with the sidecar. Size and timestamps are invalidation hints, not proof that content is unchanged.
- The same known file identity moved between visible paths produces one v2 move.
- A visible-to-visible directory move does not emit descendant moves. Descendants keep their parent-ID relationships and sync IDs.
- A vanished known identity produces delete. A new unknown identity produces create.
- Content or metadata change on the same identity produces update.
- Periodic or restart full scan repairs missed, coalesced, and overflowed watcher events. It rehashes visible regular files when the adapter cannot prove content continuity with a reliable persisted change token.

### Remote apply

- Create writes complete content before publishing the name, then binds the observed native identity to the received sync ID.
- Move resolves current and destination paths from node relationships, performs one native atomic rename, then updates the sidecar.
- Update uses the existing native write semantics and records the accepted content hash and revision.
- Delete removes the file or empty directory and retains a sidecar tombstone.
- Remote recursive delete is planned child first.
- Applied remote changes do not echo as new local mutations after reconciliation.

### Crash windows

- If the filesystem mutation did not happen, restart keeps the old sidecar state and retries or pulls.
- If the filesystem mutation happened but the sidecar write did not, restart reconciliation observes the resulting file identity and repairs the sidecar without generating a duplicate logical operation.
- If the sidecar recorded a pending local observation before upload, restart retries it with the same operation ID.
- Sidecar corruption or an unverifiable identity mismatch triggers a full authoritative reconciliation. It must not silently bind a server sync ID to an uncertain local object.

### Content

- Reuse a cached hash only when native identity and a reliable content-change token are unchanged. Treat mtime and size only as cheap reasons to invalidate the cache.
- A pure move with uninterrupted observation and proven content continuity reuses the cached hash and uploads no bytes. A repair scan must rehash when it cannot prove continuity.
- Serving a blob by hash resolves the current path through the sidecar and verifies the actual bytes against the requested hash before returning them. A matching identity, mtime, and size is not sufficient.
- If bytes changed after hashing, report a retryable local-change condition. Do not send bytes under the wrong hash.

## Visibility boundary requirements

Native observation must apply visibility before ID assignment, hashing, or pending mutation creation. Keep the sidecar outside the synchronized root or in the sync engine's internally excluded state.

- Initial and repair scans prune ignored subtrees. Purely ignored nodes get no sync IDs or sync hash-cache entries.
- Classify a detected rename from old and new effective paths. visible -> visible is one move; ignored -> ignored is silent; ignored -> visible publishes fresh IDs; visible -> ignored unpublishes old IDs and keeps bytes.
- A remote move across this replica's ignore boundary fetches the subtree when it becomes visible or removes only synchronized materialization when it becomes ignored. It does not echo.
- A remote delete, replacement, or move of an ancestor cannot destroy or expose locally ignored descendants. Skip unsafe apply.
- Crash repair cannot infer identity continuity across an ignored interval. Re-entry uses fresh IDs.

### Cycle 11: external rename crosses visibility

**RED:** Rename a nested native tree through all four transitions with the fake watcher. Assert one move, no operation, complete fresh-ID publication, and complete unpublication with byte survival. Assert no ignored file is hashed or offered as a blob.

**GREEN:** Run the shared projection classifier before identity and content work.

### Cycle 12: remote apply protects caller ignores

**RED:** Configure a nested caller ignore. Receive moves across it and destructive ancestor changes. Assert fetch on ignored -> visible, removal without echo on visible -> ignored, and preservation of the ignored child on ancestor delete or replacement.

**GREEN:** Persist only remote non-materialized state needed for transitions and port ancestor shielding to native apply.

### Added acceptance criteria

- [ ] Watcher overflow and full reconciliation cannot leak an ignored node.
- [ ] The O(1) native move bound applies only to visible -> visible.
- [ ] No identity is retained or guessed across an ignored interval.

## RED/GREEN TDD specification

Use deterministic fake watcher and file-identity adapters for behavior tests. Add a smaller real temporary-directory smoke suite. Do not depend on watcher timing in unit tests.

### Cycle 1: initial scan and restart

**RED:** Scan a temporary nested tree, close the sidecar, reopen it, and assert every node retains its sync ID and parent relationship without content or path change.

**GREEN:** Add sidecar persistence, root binding, parent-first scan, and identity lookup.

### Cycle 2: external file move

**RED:** Rename one file outside `Volume`, provide candidate paths through the fake watcher, reconcile, and assert exactly one move with the same sync ID and no blob upload.

**GREEN:** Match the observed native identity and update only parent/name state.

### Cycle 3: external 4,000-descendant directory move

**RED:** Rename a directory with 4,000 descendants between visible paths outside `Volume`. Reconcile the root move candidates and assert one v2 move and unchanged descendant sync IDs. The steady-state move path must not walk descendants.

**GREEN:** Represent the tree by parent sync IDs. Do not rewrite stored descendant paths.

### Cycle 4: uncertain inode reuse

**RED:** Simulate a deleted object and a new object that reuses its inode number but has a different device or creation discriminator. Assert delete plus create with a new sync ID, never move or update.

**GREEN:** Add the native identity adapter and strict continuity rule.

### Cycle 5: missed watcher events

**RED:** Mutate several files without watcher candidates, then run full reconciliation. Include an in-place content edit that keeps the same identity and size and restores the old mtime. Assert the same create, update, move, and delete stream as direct observation, with no duplicate operation IDs.

**GREEN:** Implement full scan as repair over the same comparison rules. Rehash when no adapter-provided change token proves that bytes are unchanged.

### Cycle 6: remote move and echo suppression

**RED:** Apply a server move, crash or restart the watcher, reconcile, and assert no outgoing move echoes back. Assert one native rename and unchanged descendant IDs.

**GREEN:** Record accepted remote state and operation identity around the native apply, then repair by observation.

### Cycle 7: crash after filesystem rename

**RED:** Inject a crash after native rename succeeds but before the sidecar commit. Reopen and reconcile. Assert the node is at the new path with the same sync ID and no duplicate accepted mutation.

**GREEN:** Make reconciliation recognize the accepted or pending move from observed native identity.

### Cycle 8: crash before filesystem rename

**RED:** Persist or stage a remote move, fail before rename, restart, and assert retry performs one move or a pull resolves it. No partial mapping can claim the new location before it exists.

**GREEN:** Order sidecar intent and final state so observed filesystem state remains authoritative for local materialization.

### Cycle 9: hash race

**RED:** Change a file between hash calculation and blob read while preserving identity, size, and mtime. Assert the adapter never serves new bytes under the old hash and returns a retryable local-change result.

**GREEN:** Hash the bytes read for the response and compare them with the requested hash before the response becomes observable. Return a retryable local-change result on mismatch.

### Cycle 10: end-to-end native and SQLite sync

**RED:** Sync create, update, directory move, delete, offline restart, and bootstrap between a native temporary directory and SQLite HTTP server. Assert final tree, content, sync IDs, and revisions converge.

**GREEN:** Compose native change source, applier, blob store, sidecar, and remote v2 replica.

## Acceptance criteria

- [ ] Native sync uses the shared v2 node interface and wire protocol.
- [ ] Every replica maintains only its own native identity/local inode to sync-ID mapping.
- [ ] External and remote directory moves between visible paths produce one v2 move independent of subtree size.
- [ ] Descendant sidecar records do not store paths that require prefix rewrites.
- [ ] Ambiguous inode reuse becomes delete plus create, never an identity guess.
- [ ] Restart and full reconciliation repair missed events and both native/sidecar crash orderings.
- [ ] A same-size edit with unchanged mtime cannot survive a repair scan under a stale hash.
- [ ] A pure move uploads no content.
- [ ] Blob reads cannot return bytes under a stale hash.
- [ ] Deterministic tests do not depend on real watcher timing.
- [ ] Existing native filesystem tests remain green.
- [ ] `pnpm format`, `pnpm typecheck`, `pnpm lint:fix`, and `pnpm test` pass.

## Out of scope

- Platform-specific watcher optimization beyond the first supported host.
- A guarantee that every filesystem exposes a permanent inode identity.
- Heuristic move matching by content hash.
- Transactional atomicity between POSIX and the sidecar; reconciliation is the designed guarantee.
