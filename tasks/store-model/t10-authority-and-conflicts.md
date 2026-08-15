# T10 — Authority + conflict policy (reject and replan)

**Status:** todo
**Phase:** B — the two consumers
**Depends on:** [T8](t08-engine-core.md)
**Context:** [overview](README.md) · [design #3, contract rule 9 + "Authoritative" / "Conflicts"](../../kb/fs/fable-design.md)

## Goal

The server-side commit discipline, and the client's answer to a rejection.

## Context

Contract rule 9: tree invariants (no cycles, no duplicate names, every parent a
live directory) are enforced by the AUTHORITY's commit via guards — NOT by
every store. A replica may transiently hold detached or even cyclic rows
mid-sync; that is safe because visibility is reachability from root.

v1 conflict policy is reject-and-replan. No merges. Three-way field merge stays
a future engine module over a base cache; it changes no seam signature.

## Files

- `packages/fs/authority.ts` — a `Store` wrapper: `authority(store)`
- tests beside it

## RED

- `authority(store).commit` rejects: a duplicate live `(parent, name)`; a
  parent that is not a live directory; a cycle (move a dir under its own
  descendant); a version guard mismatch. Plain `store.commit` ACCEPTS the same
  rows — that difference is contract rule 9 and needs its own test.
- A detached cluster on a replica is invisible to path resolution
  ([T5](t05-volume-read.md)) until a later row reattaches it.
- Engine replan loop — three scenarios with two replicas and an authority hub.
  Write the expected outcome as the test name:
  - **edit / edit on one node**: the push that lost the race guard-fails; the
    engine pulls, then re-pushes the local edit on the new base; last writer
    wins at the authority.
  - **create / create of one name**: the loser's push fails the `free` guard;
    the engine pulls the winner, renames the local node to a deterministic
    conflict name (`name (conflict <replicaId>)`), and pushes that. Both files
    exist everywhere afterwards.
  - **edit vs delete**: the delete committed first; the editor's version guard
    fails against a tombstone; the engine recreates the file under a NEW id
    with the local bytes. Tombstones + versions are what distinguish this from
    a plain create — the Unison argument in the design.

**Policy note.** These three outcomes are v1 POLICY, not seam contract. If
review changes an outcome, only `engine.ts` and its tests change. Assert in the
task diff that no `store.ts` type moved.

## GREEN

`authority.ts` + a small replan module inside `engine.ts`.

## Done when

All green. `Store` and `Guard` signatures unchanged.
