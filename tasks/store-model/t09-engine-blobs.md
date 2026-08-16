# T9 — Engine: blob transfer + lazy content

**Status:** done
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

## Settled here

**Rule 10 binds the push, and the pull is deliberately the other way round.**
Pushing, this replica may hold the only copy of the bytes, so the peer takes
them BEFORE the row that names them — a crash in that window leaves an orphan
blob, and the other order leaves a committed row whose content was never stored,
which is lost data (proof 2 of 4, pinned). Pulling, the peer still holds them, so
the row lands first and the bytes follow: a row naming content this replica does
not hold is a stub the seam already allows, and a crash mid-fetch costs another
fetch. That asymmetry is what makes lazy content possible at all — the same path
with the fetch left out — and it is why 300 rows do not wait on 300 downloads.

**A hash the source cannot produce is skipped; a hash it answers wrongly is
fatal.** Skipping is the honest reading of an absent blob: the source is lazy, or
its blob was swept, and the row still belongs at the target as a stub. Failing
the drain instead would let one unfetchable file stop the whole tree from
converging, for good. Wrong bytes are a different fact — nothing in the system is
true if a hash stops naming its content — so `verifiedBlobs` throws, the cycle
fails, and the caller hears about it.

**Only bytes coming FROM a peer are verified.** The pull wraps `local.blobs` in
`verifiedBlobs`, and so does `hydratingBlobs`. The push does not: bytes leaving
this replica are its own, and rule 7 puts the check on the store that accepts a
peer's write — the authority verifies what it is handed, in
[T12](t12-sqlite-store.md) and [T13](t13-http-wire.md). Hashing on the way out
as well would cost every file a second digest and buy no new guarantee.

**A tombstone's content hash is dead weight.** A delete writes the row back with
`deleted: true` and keeps its other fields, so a tombstone still carries the hash
the file used to name. `transfer` skips deleted rows: rule 8 says nothing but the
id, version and tombstone flag means anything on them, and moving bytes for a
dead row is pure waste.

**Lazy is a wrapper, and it stays out of the protocol.** `lazyContent: true`
tells the pull not to fetch; `hydratingBlobs(local, remote)` is what makes the
stub readable, falling through to the peer on `get` and keeping what it gets.
Nothing about the choice reaches the peer or the rows — the design's claim that
selective content needs no protocol support, discharged. `has` stays a local
question in the wrapper: it answers "do I hold these bytes", which is what
decides a transfer, so a wrapper that answered for the peer too would talk this
replica out of fetching anything.

**No `store.blobs.ts`.** The wrapper needs a peer, so it belongs beside the rest
of the code that has one. It is twenty lines in `engine.ts`, and a file of its
own would add an import and nothing else.

**No single-flight around hydration.** Two concurrent reads of one stub fetch the
bytes twice and both `put` them, which is idempotent and correct. Dedup is a
cache concern with no test asking for it; `singleFlight.ts` is there if a
measurement ever does.
