# T5 — `storeVolume(store)`: read side

**Status:** done
**Phase:** B — the two consumers
**Depends on:** [T1](t01-store-types-and-memstore.md), [T2](t02-change-feed-and-lineage.md), [T3](t03-blobs.md)
**Context:** [overview](README.md) · [design #1 table A + "the two consumers"](../../kb/fs/fable-design.md)

## Goal

The POSIX read surface over a `Store`.

## Context

- Design table A (POSIX access patterns) maps every operation to seam calls
  mechanically. Follow it row by row.
- The `Volume` interface at `packages/fs/volume.ts:38` is the exact target
  surface. Do NOT change it — agents and just-bash must not be able to tell the
  new volume from the old one.
- Behaviour specs to mirror: `packages/fs/resolve.test.ts`,
  `packages/fs/chroot.test.ts`.
- Contract rule 9: upward and downward walks bound themselves with a visited
  set, because a replica may transiently hold detached or cyclic rows.

## Files

- `packages/fs/volume.store.ts` — export `storeVolume` for now; the swap task
  ([T18](t18-retire.md)) renames it to `volume`
- `packages/fs/volume.store.read.test.ts`

## RED

Against `storeVolume(memStore())`:

- Path resolution segment by segment via `child`; symlink follow with a hop
  limit; `stat` vs `lstat`.
- `stat` never calls `blobs.get` — size is on the row. Assert with a spy.
- `readdir` full listing via paged `children`.
- `readFile` = row lookup + `blobs.get`. ENOENT / EISDIR errors use the same
  `ENOENT:` / `EISDIR:` message prefixes the old volume uses.
- `readlink` from the inline `link` field; xattr reads from the row; `exists`;
  `scan` walks the tree; `chroot` composes.

## GREEN

Implement the read ops only.

## Done when

Read tests green. No write op exists yet — that is [T6](t06-volume-write.md).
