# T11 — Lifecycle wrapper: the `synced()` replacement surface

**Status:** done
**Phase:** B — the two consumers
**Depends on:** [T8](t08-engine-core.md), [T9](t09-engine-blobs.md), [T10](t10-authority-and-conflicts.md)
**Context:** [overview](README.md) · [design #3, sync engine](../../kb/fs/fable-design.md)

## Goal

The surface Frieren and the worker consume today, running on the new engine.

## Context

The surface to match is `SyncLifecycle` in `packages/sync/synced.ts` (~line
86): `flush`, `pause`, `resume`, `destroy`, `status`, `onStatusChange`,
`takeTheirs`, `takeMine`, `generation`.

Consumers that define what "match" means:

- `apps/frieren/src/fs.ts`
- `apps/worker/src/react-app/useVolume.ts`

## Files

- `packages/fs/synced.ts` — export `syncedVolume` until the retire task
  ([T18](t18-retire.md)) renames it to `synced`
- tests beside it

## RED

Against memStores:

- Status transitions connecting → syncing → synced; error on a failing remote;
  `pause` stops the loop; `resume` restarts it; `flush` runs one push+pull now;
  `destroy` stops everything.
- Debounced push after local writes — mirror the 3s / 15s constants from the
  old `synced.ts`, with fake timers.
- `takeTheirs`: discard the local store, bootstrap from `since(ø)`, converged.
- `takeMine`: start a new lineage on the authority (this maps onto the existing
  generation CAS in `packages/core/src/reset.ts` — the wrapper only needs an
  injected `reset()` capability), re-author every local row, push all; a second
  replica converges to the local baseline.

## GREEN

Implement as a thin layer: volume + engine + status. No sync-state file in the
tree — cursors use the injected slot from [T8](t08-engine-core.md).

From [T9](t09-engine-blobs.md): Frieren's `lazyContent: true` is two things
together, and one without the other is a broken replica. Pass `lazyContent` to
`sync` so the pull takes rows only, and give the volume
`hydratingBlobs(local, remote)` so a read of a stub fetches its bytes. A test
should read a file the pull never materialized.

## Done when

All green, and the exported surface is a strict match for what
`apps/frieren/src/fs.ts` consumes. Read that file and list the members in the
test, so a later drift fails loudly.

## Settled here

**The two resets are asymmetric, because the two stores are.** This replica's
own store is its to rewrite, so `takeTheirs` is expressed entirely in the
model's own terms: every live row becomes a tombstone, the push cursor moves
past them, and the pull takes the peer's feed from the top. The authority is
somebody else's, so `takeMine` cannot do the same to it and asks instead — the
injected `reset()`, which in the app is the existing `adopt-mine` CAS in
`packages/core/src/reset.ts`. That asymmetry is the whole reason there is one
injected capability and not two: a `discard()` for the local side would be a
capability no `Store` offers, for something the seam can already say.

**Moving the push cursor is what makes "take theirs" not "delete everywhere".**
The tombstones a discard writes are this replica's OWN rows, so an ordinary
push would carry them to the authority and take the volume down on every other
replica. Saving the local feed's tip is what stops that, and it takes whatever
else was waiting to be pushed with it — which is the same decision the user
just made. Pinned by a test that asserts the peer's tree is untouched.

**`CursorSlot.save` now takes `undefined`.** The empty cursor is a position —
it is where every scan starts, and what `load` already answers before there is
one — so a slot that could not hold it could not say "take that feed from the
top again". `takeTheirs` is the only caller, and the alternative was a
`clear()` beside a `save()` that both mean the same thing.

**No `pendingReset` marker, and nothing to resume.** The old engine persisted
the take-mine intent before its CAS so a crash could not lose the snapshot it
meant to publish. Here the window is empty: an interrupted `takeMine` leaves an
authority that was truncated of exactly what this replica still holds, so
running it again is both the retry and the recovery. Pinned by a test that runs
it twice.

**`generation()` reports what `reset` returned, and nothing else ever reports
one.** No part of the seam carries an epoch: a lineage lives in the cursors and
rule 11 is what fences a replica that outlived one, which is the whole job the
`generation`/`lineageId` handshake used to do. The member survives because the
app's factory reset CASes against an epoch over a route that belongs to the
server rather than to this seam — so [T17](t17-swap-consumers.md) is where that
call gets its number, and this wrapper is not the place to invent one.

**The volume always reads through `hydratingBlobs`, lazy or not.** A row naming
content this replica does not hold is the same row either way: an eager pull
moves what the peer could produce WHEN the page landed, and a peer that was
itself a stub then can answer for it now ([T9](t09-engine-blobs.md) settled
this). Making it conditional would buy a second way to fail, not a second
behaviour — so `lazyContent` is only ever passed to `sync`.

**The push trigger reads the row's author, and there is nothing else to filter
out.** The old one skipped `REMOTE_SOURCE` writes and the inos of two
`/.state` files, or every cursor advance fed itself another push. Here a
version carries its author and a cursor lives in the host's slot, so one
predicate replaces both — and the self-feeding loop cannot be written.

**`replica` is a prop, like the cursors.** The old wrapper kept its client id
in `/.state/clientid`, inside the tree it was syncing. Durable identity is the
host's problem, and the host already solved it for the two cursor slots.

**`localFirst` starts the first cycle from a timer**, rather than calling it
outright, so `connecting` is a state a caller can actually observe: the volume
is handed over, the app reads its local replica immediately, and the first
status change it hears is `syncing`.

**What is deliberately gone**, and why it needed no replacement: `negotiate`,
`handshake`, `reconcileLineage`, `resumeAction`, `checkMidSessionReset`,
`rebootstrapKeepingLocal`, `reconcileLocal`, `rmSynced`, `clearSyncState`,
`adoptAllAsLocal`, the `SyncState` file, the ino-keyed change filter, and
`ignore`. Each was an answer to a problem the seam does not have — lineage is
rule 11, echo suppression is the author tag, "what does the peer no longer
have" is the feed, and local-only data is a mount ([T15](t15-mounts.md)).
385 lines against the old 937.

**Two limits, stated rather than hidden.** A replica that did NOT initiate the
`takeMine` keeps its own authored rows and restores them to the fresh authority
— that is [T8](t08-engine-core.md)'s rule, and converging such a replica onto
the baseline exactly is what `takeTheirs` is for. And a reset rewrites the
whole store in ONE commit: atomic, so a publish is whole, at the cost of a
batch that a volume large enough could make a backend page. Neither reset is on
a hot path, so that trade waits for a measurement.
