---
project: packages/sync
status: done
source_issue: 466
---

# sync v2 phase 4: enforce authoritative revisions, name claims, and tree integrity

## Parent

[sync node identity epic](./sync-node-identity.md)

## Type

AFK correctness slice. The behavior is fully specified below; no product naming decision is required.

## Blocked by

- [phase 1: memory reference](./sync-node-identity-phase-1-memory.md)
- [phase 2: SQLite and HTTP](./sync-node-identity-phase-2-sqlite-http.md)
- [phase 3: IndexedDB](./sync-node-identity-phase-3-indexeddb.md)

## Context for a fresh agent

Stable identity makes one-node moves possible, but last-write-wins per path can no longer protect the tree. The server must serialize location changes and reject mutations that were based on stale node state.

Use the server as the authority. Do not add a full three-tree planner or peer-to-peer CRDT in this phase.

Read the node mutation contract and adapter conformance from phases 1-3. Also read current generation and lineage fencing in:

- `packages/sync/synced.ts`
- `packages/core/src/reset.ts`
- `packages/core/src/fs.ts`
- `packages/core/src/fs.client.ts`

## What to build

Implement deterministic server acceptance rules for v2 node mutations and typed client handling for rejection.

Every authored mutation must include:

- a globally unique operation ID for retry identity;
- the target sync node ID;
- the author's last observed node revision (`0` only for create);
- mutation-specific fields.

The server returns an accepted mutation or a typed rejection. It assigns the next node revision only after all checks pass and commits the accepted state and journal entry atomically.

A rejected mutation must not change the tree, mapping, node state, content references, or journal.

## Complete behavior

### Retry

- The first accepted `operationId` stores its result.
- Repeating the same operation ID with the same canonical request returns the same accepted result and adds no journal row.
- Reusing an operation ID with a different request is rejected as invalid.
- Retry is checked before stale-revision rejection, so a lost successful response can be retried safely.

### Revisions

- Create requires an unknown sync ID and `baseRevision = 0`.
- Update, move, and delete require a live known sync ID and `baseRevision` equal to the current accepted revision.
- An accepted mutation increments that node's revision exactly once.
- A stale mutation returns the current server node state and does not advance its revision.
- A client does not advance its push cursor for a rejected local mutation. It pulls current state before it can replan or resubmit intent.
- Do not silently convert a stale mutation into last-write-wins.

A single node revision serializes metadata, content, location, and deletion in v2. This is intentionally simple. A later task can split revision domains if real contention justifies it.

### Names and parents

- Names must be non-empty, NFC, contain no `/`, and not equal `.` or `..`.
- The destination parent must be known, live, and a directory.
- At most one live node can own `(parentId, name)`.
- Create or move to an occupied name is rejected with the occupant's sync ID and state.
- A no-op move to the node's current parent and name is an idempotent accepted result without a new revision or journal row.
- The root cannot move or delete.
- Node type is fixed at create. Update cannot change regular file, directory, or symlink type.
- V2 keeps the existing one-dirent-per-inode rule. Hard links remain unsupported.
- A raw `Storage.putDirent` insert or replacement is not enough information to infer
  a v2 create or move. V2 authors must use the atomic create/move path or receive a
  typed rejection before the filesystem changes.

### Cycles and directories

- A directory cannot become its own parent.
- A directory cannot move below any of its descendants.
- The server checks cycles inside the same transaction as the move.
- Deleting a directory with live children is rejected. Recursive delete is represented as child-first node deletes.
- A rejected parent delete does not tombstone or detach anything.

### Delete and path reuse

- Delete removes the local inode and location claim, then retains the sync ID as a tombstone with its accepted revision.
- Update, move, or a second logical delete against a tombstone is rejected as deleted unless it is an exact operation retry.
- Create cannot reuse a tombstoned sync ID.
- A new sync ID can claim the released parent and name after deletion.

### Content

- A regular-file create or update requires a valid content hash and present blob.
- Directories and symlinks cannot carry a content hash.
- A move never changes or validates blob presence because it does not change content.
- A rejected update cannot leave an inode referencing a missing blob.

### Authentication and lineage

- The server stamps the authenticated caller as origin and ignores caller-supplied origin.
- Existing generation and lineage fences apply before mutation acceptance.
- A mutation from a stale generation or different lineage is rejected without recording its operation ID as accepted.

## RED/GREEN TDD specification

Run every cycle against the public HTTP replica path with SQLite. Add the same adapter-independent cases to memory and IndexedDB conformance when applicable.

### Cycle 1: exact retry

**RED:** Send a create, lose or ignore its response, and send the exact request again. Assert one node, one revision increment, and one server journal row. Reuse its operation ID with a different name and assert typed invalid rejection.

**GREEN:** Persist accepted operation identity and canonical result in the acceptance transaction.

### Cycle 2: two concurrent moves

**RED:** Two clients read the same node revision and move it to different locations. Submit A then B. Assert A succeeds, B gets a stale rejection with A's current state, and the tree exists only at A's destination.

**GREEN:** Add revision compare-and-advance to move acceptance.

### Cycle 3: move versus delete

**RED:** Submit move then delete and delete then move from the same base revision. In both orders, assert the first accepted mutation wins and the second is rejected without a journal row or partial tree state.

**GREEN:** Apply one revision rule across move and delete.

### Cycle 4: occupied destination

**RED:** Move a node onto a name held by another live node. Assert typed collision rejection, both original nodes remain unchanged, and retry after the occupant is deleted can succeed only after rebasing to current revision.

**GREEN:** Enforce the live `(parentId, name)` claim in every adapter and server transaction.

### Cycle 5: cycle prevention

**RED:** Build `A/B/C`, then attempt to move A below C and B below itself. Assert typed cycle rejection and an unchanged reachable tree after restart.

**GREEN:** Add transaction-local ancestor validation. Do not materialize or rewrite descendant paths.

### Cycle 6: invalid parent and name

**RED:** Test missing, deleted, regular-file, and symlink parents, plus empty, slash-containing, dot, dot-dot, and non-NFC names. Assert typed rejection and no recorded mutation.

**GREEN:** Add canonical validation at the wire and acceptance seams.

### Cycle 7: non-empty directory delete

**RED:** Attempt to delete a directory with live children. Assert rejection. Send child-first deletes and assert the complete tree is removed with one mutation per deleted node.

**GREEN:** Add the live-child check and preserve child-first recursive-delete planning.

### Cycle 8: tombstone identity

**RED:** Delete a node, retry its delete, attempt to update or move it, attempt to create with the same sync ID, then create a new ID at its old location. Assert only the exact retry succeeds for the old ID and the new object remains distinct.

**GREEN:** Add tombstone-specific acceptance behavior.

### Cycle 9: content and lineage rejection

**RED:** Test missing blob, wrong-type content hash, stale generation, and wrong lineage. Assert that no rejected request changes node revision, journal, mapping, or current readable content.

**GREEN:** Order validation and fencing before accepted-operation persistence.

### Refactor only after GREEN

Centralize acceptance rules only after the complete behavior passes on SQLite. Reuse them for memory and IndexedDB without leaking database details into the shared module.

## Acceptance criteria

- [x] Every behavior above has a public integration test.
- [x] Retry, stale mutation, collision, cycle, and deleted-node results use typed errors.
- [x] Rejections have no filesystem or sync persistence side effects.
- [x] The accepted operation and its returned result survive restart.
- [x] Memory, SQLite, and IndexedDB implement the same acceptance semantics where they act as an authority.
- [x] A stale local mutation remains pending until the caller explicitly replans; no intent is silently dropped.
- [x] No conflict path enumerates or rewrites descendants for a valid move.
- [x] Existing v1 behavior stays green.
- [x] `pnpm format`, `pnpm typecheck`, `pnpm lint:fix`, and `pnpm test` pass.

## Out of scope

- Automatic conflict copies or user-facing conflict UI.
- A three-tree planner.
- Peer-to-peer simultaneous-write convergence without a server.
- Separate metadata and location revision counters.
- Ignore-list projection and compound boundary operations; the dedicated reconciliation task owns them.
