# T14 — Native FS Store

**Status:** todo
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
