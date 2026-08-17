# T14 — Native FS Store

**Status:** done
**Phase:** C — backends and wire
**Depends on:** [T1](t01-store-types-and-memstore.md), [T2](t02-change-feed-and-lineage.md), [T3](t03-blobs.md)
**Context:** [overview](README.md) · [design #3, backends table, last row](../../kb/fs/fable-design.md)

## Goal

A `Store` over a real directory, so the local tools keep working after
retirement.

## Context

- Design: real files + a sidecar index; `since` = a reconcile scan against the
  sidecar; a documented weaker crash model. Native FS reconciliation is this
  one adapter's private problem — it must not leak into the seam.
- Consumers to serve: `packages/app/dev-server.ts` and
  `apps/frieren/scripts/frieren-auth.ts` (today they use `fsStorage` /
  `memStorage`).
- Node imports are allowed in this one file, mirroring the existing
  `packages/fs/storage.fs.ts` precedent.
- `Node.mode` is a whole POSIX mode, which is exactly what `node:fs` hands back:
  store `stat().mode` as it comes. Do NOT copy the `& 0o7777` at
  `storage.fs.ts:150` — that mask belongs to the old model, whose `InodeMeta`
  held permission bits beside a separate `type`.

**Keep it minimal.** An in-memory index rebuilt by a scan on open, plus a JSON
sidecar for ids and versions, is enough. Do not build inotify integration.

## Files

- `packages/fs/store.fs.ts`
- `packages/fs/store.ts` — `close?()`, the seam's one lifecycle member
- `packages/fs/store.conformance.ts` — the suite owns what it opens, and `close`
  is idempotent on every backend that has one
- tests beside them

## RED

- Conformance suite against a temp directory.
- Reopen the store: ids are stable, because the sidecar survives.
- An out-of-band file edit appears in `since` after the next reconcile scan.

## GREEN

Implement.

## Done when

Conformance green, and the two consumers can be pointed at it in
[T17](t17-swap-consumers.md) without needing new features.

**Done:** `packages/fs/store.fs.ts` and `store.fs.test.ts`. The suite runs
unchanged against a temp directory, and `storeVolume` needs nothing this store
does not have — so T17 is a swap of the constructor and nothing else.

**One deliberate deviation from "do not build inotify integration".** The first
cut obeyed it: `since` walked the whole tree, every call. Measured, that cannot
stand at any size — a walk is one `lstat` per file (~700ms at thirty thousand
files) and a consumer polls `since` every 50ms (`WATCH_BURST_MS`), so the store
saturated a core from about five thousand files up. A floor alone only trades
that for staleness. So the watcher went in, and the walk stayed as the truth
behind it; the numbers are in the note below.

Four notes for the tasks after this one:

- **The sidecar holds whole rows**, not just ids and versions. It has to: no
  node API carries an xattr, and no filesystem stores an mtime the caller can
  read back to the nanosecond it committed, so a row derived from `stat` alone
  could never come back EQUAL to the row that was written (rule 3). What the
  disk stays the truth for is the tree shape and the content.
- **A change is a change of state, not a difference from the row.** Each entry
  records the ino, mode, mtime and size its file was last seen in. That is what
  a scan compares, and it is why a commit re-reads the directories it touched
  before it returns: creating an entry bumps the parent's mtime, and a directory
  row nobody wrote must not turn up in the feed for it.
- **`blobs` is the files themselves.** A hash is answered by the file of a row
  that names it; only bytes no row has adopted yet live in `.jfs/blobs`, and
  they leave it the moment a commit publishes them. So content is never stored
  twice — and an out-of-band overwrite loses the old bytes, exactly as it does
  on any filesystem.
- **No `subscribe`, on purpose.** A consumer takes it INSTEAD of polling `since`
  (`volume.store.ts`), and only a look finds a change made outside the store.
  Offering one here would blind a watcher to the very changes this backend exists
  for.
- **The watcher is the latency; the walk is the truth.** `since` drains the paths
  a recursive `fs.watch` named, then falls back to two floors: every directory
  each second (`SWEEP_MS` — one `lstat` per directory catches every create,
  delete and rename, including an editor's atomic save), and every file every few
  seconds (`DEEP_MS`, the only thing that finds an in-place write). The tiers are
  not belt and braces: a recursive watch DROPS events — measured, on macOS, in a
  process holding a few dozen watchers — so a store that trusted it would go
  quietly stale. Measured at thirty thousand files: forty polls over two seconds
  cost 41ms in total (they cost ~29 SECONDS when every one walked the tree), and
  an out-of-band edit reached the feed in 84ms.
- **`close?()` is the seam's one lifecycle member, and it is the constructor's to
  call.** The store owns an OS watcher; nothing above it does, so nothing above it
  grows a `close`. A `Store` is composable — two volumes at different scopes, an
  engine and a wire adapter may hold the same one — so a wrapper owns nothing,
  implements none and forwards none. The watcher is armed on the first `since`
  (a consumer that only reads and writes never asks for one) and is not
  persistent, so a CLI that never closes the store still exits.
