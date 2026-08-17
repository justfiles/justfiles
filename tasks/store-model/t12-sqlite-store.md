# T12 — SQLite Store (server)

**Status:** done
**Phase:** C — backends and wire
**Depends on:** [T1](t01-store-types-and-memstore.md), [T2](t02-change-feed-and-lineage.md), [T3](t03-blobs.md) — independent of Phase B
**Context:** [overview](README.md) · [design #3, backends table](../../kb/fs/fable-design.md)

## Goal

The authority's durable backend.

## Context

- Schema per the design backends table: one `nodes` table (id PK, parent, name,
  type, mode, mtimeNs, size, xattrs JSON, content, link, version, deleted,
  seq), indexes on `(parent, name) WHERE NOT deleted` and `seq`; one `blobs`
  table.
- Existing SQLite idioms and test setup: `packages/core/src/storage.sqlite.ts`
  and its conformance test. Copy the setup; do NOT import the old store.
- Guards evaluate in the SAME transaction as the writes.
- This lives in `packages/core` because it is server code —
  `packages/fs` stays dependency-free.

## Files

- `packages/core/src/store.sqlite.ts`
- `packages/core/src/store.sqlite.test.ts`

## RED

Run the full T1–T3 conformance suite. Add:

- Guard + writes in one SQL transaction: fail a guard, count rows, zero
  written.
- `seq` is monotonic across reopens.
- Lineage id persists across reopens — a reopened store ACCEPTS its own old
  cursors. This differs from memStore (which mints a new lineage per instance)
  and needs its own test.

## GREEN

Implement.

## Done when

Conformance green in the core package's SQLite test environment, and
`pnpm typecheck` green.
