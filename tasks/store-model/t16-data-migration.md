# T16 — Data migration

**Status:** done
**Phase:** D — namespace, migration, swap, retire
**Depends on:** [T4](t04-indexeddb-store.md), [T12](t12-sqlite-store.md)
**Context:** [overview](README.md) · [design, "Relation to the current code"](../../kb/fs/fable-design.md)

## Goal

One pass: old twin-model data → `Node` rows. Ids survive.

## Context

The migration joins each inode with the dirent that named it and writes one row.

**Corrected while doing the task:** the design says `id` can simply BE the
existing ino, because every syncing backend mints `Ino` with
`crypto.randomUUID()`. The premise is true and the conclusion is not. A node
arriving from a peer is given a FRESH local ino — `applyMutation` in
`packages/sync/node.ts` calls `port.mintIno()` — so the ino is per-replica and
the SYNC id is what two replicas share. Keying rows on the ino would give a
client and a server different ids for the same file, and the first sync would
re-upload the whole volume; the zero-transfer test below catches exactly that.
So `id` is the sync id where the replica had one, and the ino where it had none
(local-only data, or a tree written before sync was attached). Both are UUIDs,
so they never collide. `kb/fs/fable-design.md` still carries the old claim.

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

## What landed

- `packages/fs/migrate.ts` — the pass itself: a walk down the old tree, one
  guarded commit per 256 rows, bytes before the rows that name them. Its header
  records what is carried and what is deliberately dropped.
- `packages/fs/migrate.idb.ts` — `migrateIdb(from, into)`, reading the old IDB
  schema directly (a new file may not import the old vocabulary, and `syncNodes`
  belongs to a package `packages/fs` cannot depend on). Copy-then-swap: the old
  database is opened read-only and never altered.
- `packages/core/src/migrate.sqlite.ts` — `migrateSqlite(db, into, blobs?)`.
  TypeScript, not a `.sql` file: a row's xattrs are one JSON column of base64,
  and SQLite has no base64. Going through the `Store` seam is what makes it
  idempotent, since rule 3 turns a re-run into no writes.

Both versions are `migrated:<revision>`, derived on both sides from the
replicated revision, so a migrated client and a migrated server hold identical
rows.

## Left for T17, deliberately

- **`/private` stops being local.** The old model kept it off the wire by
  FILTERING the path; this model has no path filter — [T15](t15-mounts.md)
  replaced that with a mount. A `/private` migrated into the replicated store is
  replicated data, and today the only thing keeping it off the wire is the
  `migrated` author, which stops applying the moment one of those rows is
  edited. The fix is a binding, and only the host knows its local store: migrate
  `/private` into THAT store and leave a `mount` row in this one.
- **Unpushed local work is stranded.** Every migrated row is authored
  `migrated`, so a row the client wrote but had not yet pushed is not pushed
  after migration either, and the server's older row is what both converge on.
  Closing it needs the old push cursor out of `/.state/sync` — state this pass
  is told to drop — or a `takeMine` re-authoring pass.
- **R2-backed server content.** `migrateSqlite` takes the bucket as an optional
  argument and copies the bytes into the new `blobs` table when given one.
  Inlining large objects into SQLite is not the shape the server wants long
  term; the seam allows a row naming bytes the store does not hold, so without a
  bucket those rows migrate as stubs.
