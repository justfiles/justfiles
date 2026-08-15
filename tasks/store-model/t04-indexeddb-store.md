# T4 — IndexedDB Store: the kill criterion

**Status:** todo
**Phase:** A — the seam
**Depends on:** [T1](t01-store-types-and-memstore.md), [T2](t02-change-feed-and-lineage.md), [T3](t03-blobs.md)
**Context:** [overview](README.md) · [design, kill criterion at the end](../../kb/fs/fable-design.md)

## Goal

Prove guarded atomic batch commit inside IndexedDB transaction rules. The
design names this the ONE structural risk in the whole model. Do it before any
volume or engine work builds up on top of the seam.

## Context

- Test setup: `import 'fake-indexeddb/auto'` FIRST — see the header comment of
  `packages/fs/storage.idb.dirty.test.ts` for why the import order matters
  (module-load `IDBKeyRange` capture reads the global).
- Schema per the design backends table: one object store for nodes with two
  indexes (`parent+name`, `seq`), one object store for blobs.
- Existing IDB idioms: `packages/fs/storage.idb.ts`. Read it for patterns; do
  NOT import it.
- The IDB hazard the design calls out: any `await` of non-IDB work inside a
  transaction auto-commits it. This is exactly why the seam is
  `commit(writes, guards)` and not a `tx(fn)` closure.

## Files

- `packages/fs/store.idb.ts`
- `packages/fs/store.idb.test.ts`

## RED

Run the FULL conformance suite (T1–T3) against `idbStore(name)`. Add
IDB-specific tests:

- All guard evaluation and all writes happen in ONE IDB transaction. No `await`
  of non-IDB work inside it. Everything async is precomputed before the
  transaction opens.
- A failed guard in a 100-row batch commits zero rows (reopen the DB and count).
- Two overlapping `commit` calls serialize; both guards evaluate against
  committed state.

## GREEN

Implement. Hash computation, row encoding — everything async happens BEFORE the
transaction opens.

## Done when

Suite green under fake-indexeddb.

**Kill criterion.** If atomic guarded batches cannot be made to work within IDB
transaction lifetime rules: STOP. Do not build a workaround. Report back — the
seam, not the engine, must change, and the design is wrong.
