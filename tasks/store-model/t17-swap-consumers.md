# T17 — Swap the consumers

**Status:** todo
**Phase:** D — namespace, migration, swap, retire
**Depends on:** [T11](t11-lifecycle-wrapper.md), [T13](t13-http-wire.md), [T15](t15-mounts.md), [T16](t16-data-migration.md)
**Context:** [overview](README.md)

## Goal

Every app runs on the new model. The old model is no longer referenced by any
app.

## Context — the full consumer list

Verified against the repo's imports:

| Consumer | Swap |
| --- | --- |
| `apps/frieren/src/fs.ts` | `idbStorage`→`idbStore` (+ migration on open); `synced()`→`syncedVolume` ([T11](t11-lifecycle-wrapper.md)); reset plumbing onto the injected `reset()` capability |
| `apps/frieren/src/apps/host.ts:295` | `REMOTE_SOURCE` import replaced by the [T7](t07-watch.md) event-source rule — export a `REMOTE_SOURCE` constant from `packages/fs` so the diff stays small |
| `apps/worker/src/react-app/useVolume.ts` | same swap; its `apiStorage` remote becomes `httpStore` |
| `apps/cli/src/volumes.ts:100` | `volume(await apiStorage(client))` → `storeVolume(httpStore(...))` |
| `packages/core/src/fs.ts` | mount `store.api.ts`; keep only the convenience routes with consumers outside the sync stack (`/file/*`, `/inodes/:ino/content/:filename`), reimplemented over the new volume; delete the rest behind the swap |
| `packages/app/dev-server.ts`, `apps/frieren/scripts/frieren-auth.ts` | `fsStorage` / `memStorage` → [T14](t14-native-fs-store.md) / [T1](t01-store-types-and-memstore.md) stores |
| `packages/core/src/*.test.ts` | the files importing `@justfiles/sync` |

Each row is independently landable, because the old code stays in place until
[T18](t18-retire.md). Split this task per row if two agents work in parallel.

One thing the swap must decide rather than inherit: frieren's app-level factory
reset CASes against a `fromGeneration`, and [T11](t11-lifecycle-wrapper.md)'s
`generation()` only ever reports what its injected `reset()` returned — nothing
in the seam carries an epoch, because rule 11 replaced that job. So the wipe
route reads the authority's current generation itself (the same handshake the
`reset()` closure needs), or the route stops CASing on one. Do not paper over it
with a default of `1`.

## RED

Each consumer's own existing test suite is the red bar. Point the consumer at
the new stack, then run the package's tests (`pnpm vitest run` in the package,
plus the `testing` skill flow for Frieren UI).

## GREEN

Mechanical swaps. No behaviour change on the `Volume` surface is expected — if
one turns out to be needed, that is a finding to REPORT, not to absorb
silently.

## Done when

`pnpm typecheck` and every package's tests are green, and

```sh
grep -r "@justfiles/sync" apps packages --include=package.json
```

shows only `packages/sync` itself.
