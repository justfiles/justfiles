# T17 — Swap the consumers

**Status:** in progress
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
| `packages/core/src/fs.ts` | mount `store.api.ts`; keep only the convenience routes with consumers outside the sync stack (`/file/*`, `/inodes/:ino/content/:filename`), reimplemented over the new volume; delete the rest behind the swap. The host needs `storeApi` ([T13](t13-http-wire.md)) and `sqliteStore` ([T12](t12-sqlite-store.md)) re-exported from `packages/core`'s index — both were left unexported on purpose, since half a server surface is no use to anyone and this is where the first consumer arrives |
| `packages/app/dev-server.ts`, `apps/frieren/scripts/frieren-auth.ts` | `fsStorage` / `memStorage` → [T14](t14-native-fs-store.md) / [T1](t01-store-types-and-memstore.md) stores |
| `packages/core/src/*.test.ts` | the files importing `@justfiles/sync` |

Each row is independently landable, because the old code stays in place until
[T18](t18-retire.md). Split this task per row if two agents work in parallel.

A second thing the swap must decide: `takeTheirs` fences its tombstones behind
an in-memory flag ([T11](t11-lifecycle-wrapper.md)), so a crash between the
tombstone commit and the saved cutoff leaves the next replica over that store
unable to tell a discard from offline deletions — and it pushes them, deleting
the volume everywhere. Closing it needs durable host state: a third injected
slot beside the two cursors, or an app-level marker like frieren's existing
`pendingFactoryReset` that re-runs `takeTheirs` before the loop starts. Decide
it here, with the app that owns durable identity in front of you.

A third thing the swap must decide: [T12](t12-sqlite-store.md)'s store commits
through `DbAdapter.transaction`, which on the Durable Object is
`await fn(adapter)` with no rollback. A rejected commit is still safe — guards
all run before any write — but a write that fails mid-batch leaves the rows
before it written, which rule 2 forbids. `storage.transactionSync` is the only
genuinely atomic transaction there and it needs a synchronous body; the
migration runner's `SyncMigrator` (`packages/core/src/migrations/utils.ts`) is
the shape that already solves this in this repo. Decide it here, where the
store first reaches a Durable Object, and decide it for `storage.sqlite.ts` at
the same time — it has the same hole in production today.

One thing the swap must decide rather than inherit: frieren's app-level factory
reset CASes against a `fromGeneration`, and [T11](t11-lifecycle-wrapper.md)'s
`generation()` only ever reports what its injected `reset()` returned — nothing
in the seam carries an epoch, because rule 11 replaced that job. So the wipe
route reads the authority's current generation itself (the same handshake the
`reset()` closure needs), or the route stops CASing on one. Do not paper over it
with a default of `1`.

## Decided here

The four questions above, answered before the first swap, plus a fifth the swap
found. Each answer is implemented where it is named.

### `/private` is a mount on the SERVER too — the one thing the row list missed

The old engine kept `/private` off the wire with a path filter
(`PRIVATE_PREFIXES`), and this model has none: [T15](t15-mounts.md) replaced it
with a mount. So the moment the server's tree becomes one synced `Store`, the
DO's `/private` — credentials, the sealed provider records — is in the table the
client pulls. Shadowed by the client's own binding, and still on the client's
disk. That is not a leak the swap may ship with, so:

- The DO holds TWO stores over its one database: the synced tree, and a
  namespaced local one bound at `(ROOT, 'private')`. `storeApi` is handed the
  synced one alone, so no request can name a row in the other — the same
  argument [T15](t15-mounts.md) makes for the engine.
- The mount row at `(ROOT, 'private')` is announced, not silent: it reserves the
  name on every replica, so no client can commit a `/private` into the synced
  store, and `authority.ts`'s `holdsRows` then makes a subtree under it
  unspellable.
- The client does the same with its own local store, and the migration splits
  the old tree at that name — which is the half
  [T16](t16-data-migration.md) explicitly left to this task.

### The half-done discard: a third injected slot in [T11](t11-lifecycle-wrapper.md)

Not an app-level marker. The alternative the task offers — "re-run `takeTheirs`
before the loop starts" — cannot be written from outside, because
`syncedVolume` starts its own loop before it returns the volume the app would
call `takeTheirs` on; the app's first chance to act is already after the first
cycle may have pushed the tombstones. So `SyncedProps` takes a durable
`discard` flag beside the two cursors, the wrapper raises it before the first
tombstone and lowers it after the pull cursor is rewound, and a wrapper built
over a raised flag finishes the discard BEFORE its first cycle. Reordering the
two halves is not an option: the cutoff has to be taken after the tombstones, or
it does not cover them.

The slot is optional, and a wrapper without one keeps today's in-memory flag —
that is a test's business, not an app's. Both apps pass one.

### The Durable Object's commit: `sqliteStore` speaks a SYNCHRONOUS seam

`DbAdapter.transaction` is `await fn(adapter)` on the DO, so a write that fails
mid-batch leaves the rows before it — rule 2's other half. `transactionSync` is
the only genuinely atomic transaction there and it needs a synchronous body, so
`sqliteStore` takes `SyncDb` (`db.ts`) instead: `exec`, `query`,
`transactionSync` — the shape `migrateSync` already runs on. Nothing in the
store ever awaited anything but the database, so this costs it no capability,
and both backends underneath were synchronous all along (`node:sqlite`,
`sql.exec`). It also drops the async serialization queue `createSqliteAdapter`
needs: a synchronous body cannot interleave.

`storage.sqlite.ts` keeps its hole. Fixing it means porting the old model's
mutations, which resolve paths and enumerate subtrees inside their transactions,
onto a synchronous seam — and [T18](t18-retire.md) deletes the file. The hole
leaves with it, and this swap is what makes that true.

### The wipe route reads the generation itself

Frieren's factory reset CASes on `fromGeneration`, and `generation()` only ever
reports what `reset()` returned — which is `undefined` on a replica that never
ran `takeMine`. So the epoch is READ, not remembered: `createFsApi` keeps one
non-seam route that reports it, and both callers that need one — the wipe and
the `reset()` closure — read it there. It is the server's protocol, not the
seam's, which is what `synced.ts` already says about `generation()`.

## Order of the swap

The rows are not as independent as the table above suggests, and one of them is
not a row at all. What decides the order:

1. **The decisions first** — the atomic commit and the namespace
   ([T12](t12-sqlite-store.md)'s file), then the durable discard slot
   ([T11](t11-lifecycle-wrapper.md)'s).
2. **A server and its own clients are ONE step.** The old routes serve the old
   tables and `storeApi` serves the new ones; a server mounting both would let a
   write land in a table the other half cannot see. Frieren and worker own
   separate databases and separate clients, so that step is per APP — which is
   what keeps the two apps independently landable, and it needs the new server
   surface to arrive UNDER A NEW NAME beside the old one, the way every other
   task in this story ran the two models side by side.
3. **`/private` before either.** The mount row, the second store, and the
   migration that splits the old tree at that name. Nothing may reach the wire
   before this: the first pull after the swap would otherwise copy the DO's
   credentials onto every client.
4. **The standalone volumes** — `apps/cli`,
   `apps/frieren/scripts/frieren-auth.ts` go with the server they talk to;
   `packages/app/dev-server.ts` talks to none and goes whenever.

So the task lands as a stack, each PR on the one before it, each green on its
own:

| PR | What | State |
| --- | --- | --- |
| 1 | The decisions: atomic commit + table namespace, the durable discard slot, this order | landed |
| 2 | `/private` is a mount: the announced row, the second store, the migration split, `emptyStore` + the reset on the synchronous seam | next |
| 3 | The new `/fs` surface beside the old one, and frieren onto it: DO host, browser client, `apps/cli`, `frieren-auth` | |
| 4 | `apps/worker` onto it, then the old surface deleted: the retired routes, `apiStorage` / `remoteSyncReplica`, the old-wire tests, the dependencies | |

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

shows only `packages/sync` itself — with ONE exception, reported rather than
papered over: `packages/core` keeps it as a **devDependency** for
`migrate.sqlite.test.ts`, whose fixture is built through the old stack end to end
(that is what makes the migration proof worth anything). The production code in
`packages/core` imports none of it. It leaves with the fixture in
[T18](t18-retire.md), which is also where that file's own list puts the rest of
core's retirement.
