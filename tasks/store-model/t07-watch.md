# T7 — `watch` from the feed

**Status:** todo
**Phase:** B — the two consumers
**Depends on:** [T6](t06-volume-write.md)
**Context:** [overview](README.md) · [design #1 table A, watch row](../../kb/fs/fable-design.md)

## Goal

`Volume.watch` synthesized from committed row diffs.

## Context

- `packages/fs/watch.test.ts` is the behaviour spec: burst folding via
  `WATCH_BURST_MS`, recursive scoping.
- Design: watch events are row diffs from the commit feed; the effective path
  of a node comes from an upward parent walk, bounded with a visited set
  (contract rule 9).

### Event source — the one behaviour change

The old model tags events with `MutationOptions.origin` (`REMOTE_SOURCE` in
`packages/sync`). The new model has NO origin tags — the design deletes them.

Instead: `Version` carries its author replica id (design push-filter bullet). A
watch event's `source` is derived from the version's author — `remote` when the
author is not this replica, otherwise undefined. Frieren's filter at
`apps/frieren/src/apps/host.ts:295` keeps working through this.

Write this reasoning down in the code where `source` is derived. It is the kind
of fact the next reader cannot recover from the types.

## RED

- Port the `watch.test.ts` scenarios to `storeVolume`.
- Add: a row committed by a foreign author surfaces `source: 'remote'`.

## GREEN

Implement over `subscribe` when the store has it, else poll `since`.

## Done when

Watch tests green with BOTH mechanisms — subscribe present and absent. memStore
can hide `subscribe` behind a flag in the test.
