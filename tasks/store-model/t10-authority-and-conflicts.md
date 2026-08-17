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

**"Every parent a live directory" took four passes to state once.** It was
written three times as a condition on a CHANGE — a child gaining a bad parent,
a directory being re-typed, a re-type that strands children — and each reading
left a way in. The invariant does not mention change at all: anything that is
not a directory has no live rows beneath it, whatever it was before and whether
or not this store ever saw it. That last clause is the one the leniency for
detached rows demands: children may arrive before their parent, so the row that
finally binds them is the last chance anything gets to ask what they are being
bound to — nothing carries them past it, because nothing changes them again.

**Every check reads the batch, including the one that nearly did not.** A
commit is atomic, so what it does to a row counts as already done for the rest
of it: a rename that gives a name away and takes it back is one commit, and so
is a re-type that empties the directory as it goes. The re-type check was
written against the pre-commit children alone on the grounds that no writer
produces such a batch — true, and the wrong test. The rule this file states is
"refuse only what no later row can repair", and a batch that clears the
children repairs it in the same commit, with no later row needed at all.
Refusing it would also have no way out: `settle` has no answer for a page
refused that way, so it comes back unchanged until the budget runs out.

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

A revival mints a NEW id and never moves into whatever already stands at the
name, and it remembers what it minted only for the settlement that minted it.
Both limits were paid for. Reusing the standing row merges a subtree split
across pages — and silently swallows an edit when the peer deleted a file and
created another under the same name. Carrying the id between settlements joins
the split properly — and silently buries content when a settlement is refused,
because the id it picked then names a row that was never written and the next
settlement reads it as already dealt with. Two attempts at the same nicety, two
ways to lose data.

So the nicety is dropped. A rescue too wide for one page lands as `docs` and
`docs (conflict b)`: split, legible, and whole. That is the same shape v1
already ships for a name conflict, and it is the honest failure mode — the
alternative was files disappearing while sync reported success. What remains is
a memo inside one settlement, which is not the same feature: rows share
containers, so without it a page of a hundred rows stands up a hundred copies
of the one directory they all sit in.

**A conflict name is probed until it is free, not proposed and re-proposed.**
`name (conflict <replicaId>)` is the first candidate, and the settlement asks
the authority whether it is taken; if it is, the name is numbered
(`name (conflict b 2)`) until one is free. Advancing a suffix and waiting for
the next refusal costs a replan per name already taken — and a local rename
does not restore the budget, only a page that reaches the peer — so a chain of
occupied names longer than the budget never lands at all. Numbering rather than
re-suffixing also keeps the answer readable: a name that grew a suffix per
collision replicates everywhere at that length.

The probe asks THREE places: the peer, the local store, and the names this
settlement has already given out. Rule 1 says which of two live rows for one
name is visible — not that two cannot exist — so one refused page may carry two
rows losing the same name, and answering both by the same rule answers them the
same way. The third place is the one nothing else can see: a rename still
sitting in `fixes` is in neither store yet.

The probe asks BOTH stores. The peer is the arbiter, but it cannot see what has
not reached it, and a name free there and held by an unpushed row here is the
one name the rename must not pick — the next push would claim it twice in one
batch, which the authority refuses as a whole, and no settlement could say why,
since neither name is taken where it looks.

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
