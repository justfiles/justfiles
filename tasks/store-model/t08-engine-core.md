# T8 — Engine core: pull, push, cursors

**Status:** todo
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
