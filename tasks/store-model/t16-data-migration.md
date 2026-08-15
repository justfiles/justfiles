# T16 — Data migration

**Status:** todo
**Phase:** D — namespace, migration, swap, retire
**Depends on:** [T4](t04-indexeddb-store.md), [T12](t12-sqlite-store.md)
**Context:** [overview](README.md) · [design, "Relation to the current code"](../../kb/fs/fable-design.md)

## Goal

One pass: old twin-model data → `Node` rows. Ids survive.

## Context

Every syncing backend already mints `Ino` with `crypto.randomUUID()` (verified
at `packages/fs/storage.mem.ts:64` and `packages/fs/storage.idb.ts:405`), so
`id` can simply BE the existing ino. The migration joins each inode with its
dirent and writes one row.

Sources:

- Client IDB — `packages/sync/storage/idb.ts` schema, the journaled one Frieren
  uses, DB names `frieren-fs-profile-*`.
- Server SQLite — `packages/core/src/storage.sqlite.ts` schema plus
  `packages/core/src/migrations/`.

## RED

- Build a fixture through the OLD stack (volume writes over old idbStorage /
  sqlite), run the migration, open with the NEW store: same tree via
  `storeVolume`, same ids, same content hashes, blobs present.
- Old journal rows, snapshot sessions, and sync-state files (`/.state/*`) are
  DROPPED, not migrated. `/.state` itself does not exist afterwards.
- **Version stamping:** migrated rows get a server-authored version on the
  server and a `migrated` author on clients — so the first client push after
  migration sends ZERO rows (author filter) and the first pull no-ops on
  identical rows. Test exactly that: a migrated client and a migrated server
  sync with zero row transfers and zero blob transfers.
- The migration is idempotent: run it twice, same result.

## GREEN

- `packages/fs/migrate.idb.ts` — old IDB → `store.idb`. Pick copy-then-swap of
  DB names over an in-place version upgrade; it is resumable.
- A core migration for SQLite.

## Done when

All green, including the zero-transfer convergence test — that test is what
proves users will not see a full re-upload on the day this ships.
