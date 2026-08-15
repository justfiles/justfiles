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

- Delete the retired routes in `fs.ts`, `apiStorage` / `remoteSyncReplica` in
  `fs.client.ts`, the old `storage.sqlite.ts` node and journal machinery, and
  dead migration guards.

**Docs:** update `docs/app.md` and any kb docs that name the old vocabulary.

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
