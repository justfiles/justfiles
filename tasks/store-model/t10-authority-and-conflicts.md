# T10 — Authority + conflict policy (reject and replan)

**Status:** done
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
- **A local edit that lands mid-cycle is not lost.** Handed over by
  [T8](t08-engine-core.md), which cannot close it: the pull there applies rows
  blind, so a write committed after the push drain reached its tail and before
  the pull commits its page is overwritten, and the next push skips the row
  because what it finds there is the peer's. Push-first narrowed this to the
  cycle's own duration; it does not remove it. The fix belongs with the machinery
  this task already needs for edit/edit — read the row being replaced, guard the
  pull's commit on it, and let a rejection replan — so write the test first:
  commit a local edit between the push drain's tail and the pull's commit, and
  assert it survives and reaches the authority.

**Policy note.** These three outcomes are v1 POLICY, not seam contract. If
review changes an outcome, only `engine.ts` and its tests change. Assert in the
task diff that no `store.ts` type moved.

## GREEN

`authority.ts` + a small replan module inside `engine.ts`.

## Done when

All green. `Store` and `Guard` signatures unchanged.

## Settled here

**The authority serializes; it does not add guards.** Every check reads the
store and then writes, and those two have to be one step. The design already
said how — the server "serializes accepted writes into its feed" — and a queue
of one makes all four checks sound without a single extra guard. Guards were
the alternative and the worse one: two of the invariants have no guard form at
all, and the cycle check expressed as guards puts a version guard on every
ancestor of every write, so one create deep in a tree starts rejecting its
neighbours. The price is a contract in prose: `authority(store)` must be that
store's ONLY commit path. A writer that reaches past it is outside the
discipline, and nothing in the wrapper could tell.

**A missing parent is allowed; a parent that is present and not a live
directory is not.** This one was not obvious and it is load-bearing. Every
create stamps its parent directory, which moves that directory's row AFTER the
child in the feed — so a paged push routinely offers children before parents,
and a strict reading ("every parent a live directory, always") would reject the
first page of every bootstrap and demand the parents-before-children wire
ordering this whole model exists to delete. Rule 9's own text is the licence:
a detached cluster is invisible until later rows reattach it. So the authority
refuses only what no later row can repair.

**"Every parent a live directory" means a real directory, and that is what
keeps a mount's subtree out of the synced store.** The design rests its whole
local-data story on one line — "only a directory can be a parent, so the mount
node can never have children ... on any replica, buggy or not" — and the place
that sentence becomes true is this check. So `authority.ts` has `holdsRows`
(`dir` only) where `volume.store.ts` has `isDir` (`dir` or `mount`), and the
two must not be merged: a junction stands where a directory would for
resolution and `stat`, and holds nothing in THIS store. [T15](t15-mounts.md)
inherits the enforcement rather than adding it.

**The root needs its own line, three times over.** It is the one row with no
parent to vouch for it, so every other check passes it through: a tombstone
for it, a re-type of it, and a reparent of it were all accepted. The last is
the subtle one — the root being its own parent is where an upward walk stops,
so a root parented on its own descendant is a cycle every walk below steps
over rather than finds.

**Tombstones are terminal.** Nothing brings a dead id back. That is the rule
that makes edit-vs-delete a different answer from a plain create — the
distinction Unison needs a common base for — and it is what turns the editor's
push into a rejection instead of a silent resurrection.

**Both directions of the cycle name the base they are replacing.** `bases`
reads the rows a page is about to overwrite and guards the commit on them, so
push and pull are read-modify-writes rather than blind applies. On the push
that is what makes an edit/edit race a rejection the loser can replan; on the
pull it is what stops a local write landing mid-cycle from being overwritten.
It costs one `get` per row, and the push filter leaves the steady state with no
rows at all, so the steady state still costs nothing.

**The mid-cycle window needed two mechanisms, not one.** The guard closes the
half where the write lands after the base was read. It cannot close the other
half — a write that lands while the pull page is still in flight is already
there when the base is read, so the guard passes and the edit is overwritten.
What closes that one is the pull refusing to apply a page over work the peer
has never been offered: it re-drains the push first, and starts the cycle over
if that drain sent anything. One local `since` that returns nothing, in the
steady state. Both halves are pinned by their own test.

**Edit-vs-delete has a second half: the buried CONTAINER.** Recreating the
edited file under a new id is only the leaf case. When what the other replica
deleted is the directory this replica was working inside, the work still names
the buried id, and a row parented on a tombstone is refused for ever — taking
every row that shares its page down with it, so the sync never converges at
all. `settle` therefore walks up to the first ancestor the peer still has,
standing each buried directory back up under a new id. It walks rather than
steps because a stamped directory's own parent is usually buried too: level by
level it would cost a replan a level, and a path deeper than the replan budget
would never converge. Who gets rescued needs no rule of its own — only rows
this replica AUTHORED reach `settle`, because the push filter is what built
the page, so the delete keeps everything else.

**`settle` writes locally and lets the ordinary push carry it.** A rename of
the loser, a recreate under a new id, or nothing at all — each is a local
commit, and a written row moves to the end of the local feed (rule 4), so the
re-scan offers the fix and no longer offers what was refused. No special push
path, and no engine state. The peer is what `settle` reads, because the peer is
the arbiter: asking the local store would ask a replica holding two live rows
for one name (rule 1) which of them won.

**What moved in `store.ts`:** `GuardError` now also takes a reason string. No
type moved — `Store`, `Guard`, `Node` and `Page` are untouched. The authority
refuses for reasons no `Guard` can state, and a caller has to see the same
type either way, since that one type is what the engine's replan turns on.
