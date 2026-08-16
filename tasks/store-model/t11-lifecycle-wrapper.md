# T11 — Lifecycle wrapper: the `synced()` replacement surface

**Status:** todo
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
