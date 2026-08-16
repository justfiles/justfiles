# T7 — `watch` from the feed

**Status:** done
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

## Settled here

**What makes a recursive wake "structural".** The old model had the storage
feed say so, with a `dirent` event kind. Rows carry no kind, and the feed hands
over the row's new state, not a diff against the old one — so the signal is
[T6](t06-volume-write.md)'s parent-`mtime` rule read backwards: a create, a
delete or a rename stamps the directory it happened in, in the SAME commit, so
a **directory row in the feed IS a listing that changed**. A content edit
writes one file row and no directory, which is why editing a file does not wake
a tree watcher. The correctness mechanism T6 added for `rm -r` turns out to be
the whole of watch scoping too.

Two rules follow, and they are all of it: a directory row (or a tombstone) at
or under the watched root wakes it, and a row the resolution walked through
re-resolves it — that second one is how a rename of an ancestor is noticed,
since it empties the subtree without touching one row inside it.

**Where `source` comes from.** `authorOf(version)` — everything before the
version's last `:` — compared against the author this volume mints under,
sampled once from the mint (the caller may own the format; the engine will).
The author tag inside `Version` is now load-bearing for two readers: this, and
[T8](t08-engine-core.md)'s push filter.
