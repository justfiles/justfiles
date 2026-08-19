# T18 — Retire the twin vocabulary

**Status:** todo
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
