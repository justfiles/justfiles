# T8 — Engine core: pull, push, cursors

**Status:** done
**Phase:** B — the two consumers
**Depends on:** [T1](t01-store-types-and-memstore.md), [T2](t02-change-feed-and-lineage.md), [T3](t03-blobs.md) — NOT the volume
**Context:** [overview](README.md) · [design #3, sync engine](../../kb/fs/fable-design.md)

## Goal

`sync(local, remote)` — the whole loop:

```text
pull: remote.since(cursor) → local.commit(rows) → advance cursor
push: local.since(cursor)  → remote.commit(rows, guards) → advance cursor
```

## Context

- **`Version` = `{author: replicaId, counter}`**, encoded as an opaque string.
  The engine owns encode / decode; stores never parse it. The author tag is
  what makes push echo-free: push sends only rows THIS replica authored, so
  pulled rows are never sent back. Idempotence is the safety net, not the
  steady state.
- **Cursors live in a host-local slot the caller injects**:
  `{ load(): Promise<string|undefined>, save(c): Promise<void> }`. Never inside
  the replicated table, never in the user tree. The old model's `/.state/sync`
  file does not exist here.
- The cursor advances only AFTER its batch commits. It may lag, never lead.

## Files

- `packages/fs/engine.ts`
- `packages/fs/engine.test.ts`

## RED

With two memStores (plus a third for the star topology):

- Bootstrap: `since(ø)` pull converges an empty replica; identical rows on both
  sides — compare full row sets (the convergence invariant).
- Steady state is echo-free: after a pull, the next push sends ZERO rows.
  Assert on commit calls to the remote.
- Idempotence: apply the same page twice — no-ops, same state.
- **Proof test 3 of 4:** delete the saved cursor, rerun — every re-applied page
  is a no-op and state is unchanged.
- Crash resume: kill the loop between commit and cursor save; rerun; converged.
- **Proof test 4 of 4:** a foreign-lineage cursor is rejected; the engine
  restarts from the empty cursor and converges (uses T2's typed error).
- Star topology: A↔hub, B↔hub; a write on A reaches B.

## GREEN

Implement the loop. Retries with backoff live here; keep them dumb.

## Done when

All green, with fake timers where the loop schedules itself.

## Settled here

**Two slots, not one.** The engine reads two feeds — the peer's and its own —
so it holds two positions: `{ replica, pull, push }`, where `pull` is where this
replica stands in the peer's feed and `push` where it stands in its own. One
slot each, because a `Cursor` is one opaque string and nothing in the engine
wants to parse a pair out of it. Both are host-local; neither ever reaches a
store other than the one that minted it.

**`Version` is `<replica>:<counter>`, and the counter starts at the clock.**
Zero would be wrong: a restarted replica would re-mint strings it had already
used, and a version guard captured before the restart could then pass against a
row it never saw. The author tag has two readers now — this push filter and
[T7](t07-watch.md)'s `source` — so the format is a contract between minters, and
`versions(replica)` is the minter [T11](t11-lifecycle-wrapper.md) hands to
`storeVolume`. Until it does, `volume.store.ts` keeps minting its own; T8 does
not depend on the volume, so it does not reach into it.

**Push sends no guards yet.** The loop's shape is `remote.commit(rows, guards)`,
but a guard needs a base to state, and the design declines a per-row `base`
field. What the engine can state comes from the authority's own invariants, so
the guards and the replan they trigger arrive with
[T10](t10-authority-and-conflicts.md). Until then a push is a plain commit.

**Why the retries can be this dumb.** They wrap the whole cycle, not a call. A
cursor advances only after its batch commits, so an attempt that died halfway
left nothing to unwind — re-running is both the recovery and the retry. The one
error that is NOT retried is a fenced cursor: no position in that store will
ever answer to it, so retrying is the wrong shape entirely, and the drain
bootstraps instead.
