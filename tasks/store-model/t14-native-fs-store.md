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
- tests beside it

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
  (`volume.store.ts`), and only a scan finds an out-of-band edit. Offering one
  here would blind a watcher to the very changes this backend exists for.
