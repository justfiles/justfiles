# T1 — Store types, memStore, conformance suite

**Status:** todo
**Phase:** A — the seam
**Depends on:** nothing
**Context:** [overview](README.md) · [design #2 and #3](../../kb/fs/fable-design.md)

## Goal

The `Store` interface exists, a memory backend implements it, and a reusable
conformance suite proves the core contract.

## Context

Copy the types verbatim from design #2 and #3 (`NodeId`, `Hash`, `Version`,
`Cursor`, `Node`, `Page`, `Guard`, `Store`); they are also reproduced in the
[overview](README.md#the-seam-for-reference). Add a `ROOT` constant.

Suite-factory pattern to copy:
`packages/core/src/storage.sqlite.conformance.test.ts` and
`packages/sync/node-conformance.test.ts`.

This task covers contract rules 1–3 and 6. Rules 4, 5, 11 are T2; rules 7 and
10 are T3.

## Files

- `packages/fs/store.ts` — types + `ROOT`
- `packages/fs/store.conformance.ts` — exported
  `storeConformance(name, open: () => Promise<Store>)`
- `packages/fs/store.mem.ts`
- `packages/fs/store.mem.test.ts`

## RED

Write the suite, then run it against a stub that throws. All red.

- `get(ROOT)` returns a live directory.
- `get`, `child`, `children` behave as two indexes over one table.
- `children` pages in one stable name order; a resumed cursor never skips or
  repeats an entry.
- `child` with two live rows for one `(parent, name)` returns the lowest `id`
  (contract rule 1).
- `commit` is atomic: any failed guard commits nothing, including a batch where
  the LAST guard fails.
- Both guard kinds work: `free` rejects when a live node holds the name;
  `version` CAS rejects on mismatch; `is: null` means "must not exist".
- Writes replace whole rows. Committing an identical row is a no-op.
- A tombstone (`deleted: true`) frees the name for `free` guards and disappears
  from `child` / `children`.

## GREEN

Implement `memStore()`. Two maps + an array, per the backends table in the
design.

## Done when

`pnpm vitest run store.mem.test.ts` is green and `pnpm typecheck` passes.
