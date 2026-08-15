# T9 — Engine: blob transfer + lazy content

**Status:** todo
**Phase:** B — the two consumers
**Depends on:** [T8](t08-engine-core.md)
**Context:** [overview](README.md) · [design #3, sync engine + "Selective content"](../../kb/fs/fable-design.md)

## Goal

Content moves separately from rows, deduplicated, optionally lazy:

```text
blobs: for each new content hash — has? skip : transfer (lazy where allowed)
```

## Context

- Contract rule 7: a store that accepts writes from a peer verifies the hash —
  use `verifiedBlobs` from [T3](t03-blobs.md).
- Contract rule 10: `blobs.put` resolves before the row that references the
  hash is committed.
- "Selective content" (design): rows always sync; blobs fetch on demand. A
  replica that does not want the bytes never calls `blobs.get`. This is a
  materialization choice, never an identity or visibility choice — it needs no
  protocol support.

## RED

- Push: for each authored row with a new hash — `remote.blobs.has`? skip :
  `put`. The blob `put` resolves BEFORE the row commit (spy on the order).
- A rename / move transfers zero bytes (same hash on both sides).
- Pull eager mode: fetch missing blobs after applying rows.
- Pull lazy mode: fetch nothing. Export a store wrapper
  `hydratingBlobs(local, remote)` whose `get` falls through to the remote and
  caches locally, so `storeVolume` reads a lazy stub transparently. Frieren's
  `lazyContent: true` maps to this.
- **Proof test 2 of 4:** a crash between `blobs.put` and `commit` leaves only
  an orphan blob — never a committed row whose bytes are lost.
- Remote-facing blob writes go through `verifiedBlobs`.

## GREEN

Implement in `packages/fs/engine.ts`, plus a small `packages/fs/store.blobs.ts`
if the wrapper wants its own file.

## Done when

All green, and the lazy path never calls `remote.blobs.get` until a read
demands it.
