# T18 — Retire the twin vocabulary

**Status:** done
**Phase:** D — namespace, migration, swap, retire
**Depends on:** [T17](t17-swap-consumers.md), fully landed and released
**Context:** [overview](README.md) · [design, "Review: compress until nothing can move"](../../kb/fs/fable-design.md)

## Goal

One model remains.

## Do

**Delete `packages/sync` entirely.** Remove it from the workspace and from
every `package.json`.

**In `packages/fs`:**

- Delete `storage.ts`, `storage.mem.ts`, `storage.idb.ts`, `storage.fs.ts`,
  `storage.shared.ts`, the old `volume.ts` internals, and their tests.
- Rename `storeVolume` → `volume`, `syncedVolume` → `synced`, and the `store.*`
  files to their final short names.
- Re-export the final surface from `index.ts`. Keep it as small as today's —
  the design's "be very stingy on interfaces" rule applies hardest here.

**In `packages/core`:**

- Delete `storage.sqlite.ts` and its tests. [T17](t17-swap-consumers.md) took its
  last production consumer and stopped exporting it; what is left is the fixture
  `migrate.sqlite.test.ts` builds the old tree with, which is also the last reason
  `@justfiles/sync` is a devDependency here. Both leave together.
- Delete the migration `.sql` files' dead tables, and the dead migration guards.

  ([T17](t17-swap-consumers.md) already deleted the retired routes in `fs.ts`,
  `apiStorage` / `remoteSyncReplica` in `fs.client.ts`, and `resetVolume`.)

**In `apps/mac` and `apps/runner`:** both still hold a `volume(...)` over the old
`Storage` — `nativeStorage`, `memStorage`, `idbStorage`. Neither syncs, which is why
[T17](t17-swap-consumers.md)'s consumer list left them out; they go with the files
above.

**Docs:** update `docs/app.md` and any kb docs that name the old vocabulary.

**Not done, deliberately:** the old backend's R2 objects (`<ns>/fs/blobs/sha256/…`)
are orphaned once `storage.sqlite.ts` goes, since `gcUnreferenced` is what swept
them. The store model keeps its own under `<ns>/store/…`, so nothing collides and
nothing collects. Sweeping them safely would mean checking every hash against the
new `blobs` table BEFORE `fs_contents` is dropped — the one pass writes a stub for
a blob it could not fetch, so a blind prefix delete can destroy the only copy. Not
worth the code for the number of users this has: delete the prefix by hand when you
are satisfied, or leave it.

## Done when

- This returns nothing (excluding `node_modules` and `dist`):

  ```sh
  grep -rn "InodeMeta\|MutationOptions\|SyncNodeId\|JournaledStorage\|@justfiles/sync" \
    packages apps --include="*.ts"
  ```

- Full repo: `pnpm typecheck` and `pnpm -r test` (or the turbo equivalent) are
  green.
- The final `packages/fs` file list matches the design's final form — one
  table, two lookups, one order, one guarded atomic write, one hash-keyed blob
  map, and the engine, volume, authority, and backends over it. Nothing else.

## What landed

The plan above, with four decisions it did not make.

**`volume.store.ts` merged INTO `volume.ts`** rather than being renamed beside it.
The old file held the `Volume` interface, `WatchEvent` and `chroot` as well as the
old implementation, and once the implementation went there was no second concept
left to keep in two files. `packages/fs` is now: `store.ts` (the seam), `volume.ts`
(the POSIX view, mounts and `chroot`), `engine.ts`, `authority.ts`, `synced.ts`,
the four backends (`mem` / `idb` / `fs` / `http`) with `disk.ts` under the native
one, `conformance.ts`, `migrate*.ts`, `persistedState.ts`, `types.ts`, `xattr.ts`.

**`migrate.sqlite.test.ts` was kept, with a fixture that states the old model
instead of driving it.** The task retired it with `storage.sqlite.ts`, but
`migrate.sqlite.ts` SHIPS — it runs on every DO boot until that volume is adopted —
and this is its only test, and the only cover for the claim the whole migration
rests on. A new `packages/fs/migrate.legacy.ts` describes one old tree and writes
the IndexedDB half of it; the test writes the SQL half beside itself. Both sides
come from ONE description with two ino namespaces and one set of sync ids, which
is the disagreement the pass has to survive, said directly. `migrate.idb.test.ts`
uses the same module for the same reason. `migrate.legacy.ts` leaves when
`migrate.*` does.

**The dead tables leave in a new migration (`0012`), not by editing 0002/0010/0011.**
Those already ran: a live volume's schema is what its applied migrations left
behind. 0012 drops the six sync tables and `fs_content_fts`, and the two prune
bookmarks off `fs_generation`. `fs_inodes` / `fs_dirents` / `fs_xattrs` /
`fs_contents` / `fs_sync_nodes` STAY — they are what the one pass reads, and a
volume nobody has opened since the swap has not run it yet. (`parseSqlStatements`
grew one character class on the way: a migration file ending in a comment block
used to hand the runner a statement of prose.)

## Left undone, and named

`apps/frieren/worker/usage.ts` still meters storage off `fs_contents` / `fs_inodes`,
so the number it reports has been frozen since the swap. T17 missed it and T18 does
not regress it — the tables it reads are the ones that stay. Porting it is not a
rename: the new `blobs` table has no size column, so the deduped total has to come
from the distinct `(content, size)` pairs on live rows, and the inline/R2 split from
`blobs.data IS NULL`. That is a metering change on a billable figure, so it wants
its own task and its own test.
