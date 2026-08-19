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

The four questions above, answered before the first swap, plus the ones the swap
found on its way through. Each answer is implemented where it is named.

### A store has an id, not a name — and a mount row derives from its position

The first cut gave the second store a table-name prefix (`private_nodes`), which
put a mount POINT's name in the schema: renaming a mount would have been a DDL
migration, and the identifier had to be validated because it reached SQL as text.
Both are the id/name conflation this model refuses everywhere else. So a store is
a row in `stores` and a partition of the one table set, carried as a bound
parameter — creating one is an `INSERT`, deleting one is a `DELETE`, and the mount
point's name lives in the PARENT store's row, where it may be renamed freely.

The mount row itself is DERIVED, not minted: the id is a v8 uuid hashed from
`(parent, name)`, `mtimeNs` is 0, the version is `mount:1`. Every replica writes a
byte-identical row, so rule 3 reads a second copy as a no-op and the author tag —
no live replica — keeps it off every push: the name is claimed everywhere with no
coordination and no traffic. A minted id would give two replicas two live rows for
one name, which rule 1 settles by the lowest id and the engine then RENAMES the
loser.

Deriving the id makes identity and position ONE fact, and [T15](t15-mounts.md)'s
"an unbound mount moves and goes like an ordinary row" would have let them
disagree. Removed, the row leaves a tombstone at the very id the next
announcement derives — final by rule 8, so the name is claimed for ever by a row
that is not there, and an authority-backed store can never re-announce it.
Renamed, the next announcement at the old position derives that same id and drags
the row silently back out of wherever it went. So a mount row is now `EBUSY` to
remove (named or swept up in a recursive delete), to rename away, and to replace
— `pinned` in `volume.store.ts`, beside `bound`. Retiring a mount point is
unbinding it; the claim is what the row is for.

`announceMount` states the derived id as a SECOND guard — `{ version: { id, is:
null } }` beside the `free` one — because a free NAME settles nothing when the id
is a function of the position: a tombstone frees the name, so `free` alone
passes, and the two backends then disagree, an authority refusing the write while
a raw store brings a dead id back with nothing downstream to catch it (the
`mount` author tag keeps the row off every push). A guard rather than a read
before the commit, because a read is a moment and this is a race — a peer's page
carrying that tombstone can land between any two awaits. Only a write that goes
around the volume can leave such a tombstone now.

On a real filesystem the mounted store's tree is a REAL directory under the same
root — `<root>/private`, openable in Finder — so the boundary has to be something
the bridge can see. `fsStore` already refused exactly one root-level name, its own
sidecar; a bound name goes through the same filter, which is where the design puts
it ("an import filter private to the native bridge"). One name per binding, out of
the host's own fstab: not a pattern language, and a name that is not bound is
ordinary data.

A separate database FILE per store was investigated and is impossible on the
Durable Object, permanently — workerd's authorizer refuses `SQLITE_ATTACH`: "we do
not support attached databases. It seems unlikely that we ever will." The only
per-file store there is a second Durable Object, which would make every `child()`
an RPC and could not be the synchronous seam the atomic commit needs. On
IndexedDB a store is already a whole database, named by the store's id.

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

### A store collects its own garbage, and it needs a stamp to do it

Nothing in this story gave the durable store a `gc`, and the day frieren's data
moves is the day the old daily sweep is looking at the wrong table: rule 7 makes
content immutable, so an edited file stops naming its old bytes and nothing ever
collects them. `sqliteStore` implements the seam's optional `gc` — unreferenced
by any LIVE row, a bounded slice, one transaction — and the DO's daily routine
sweeps BOTH its stores, because the bytes behind `/private` go stale exactly the
way the tree's do.

It also needs somewhere to put bytes that do not fit. A Workers SQLite ROW is capped
at 2 MB — hard — and the old backend sent every binary to R2 for exactly that reason,
so a store that inlined everything could not hold a file over that size AT ALL, and
the one pass would throw on the first such object inside `blockConcurrencyWhile` and
take every request to that user's object down with it. So `sqliteStore` takes an
optional `BlobStore` and tiers by size: the row holds small values, the external store
holds the rest, and the ROW is still what this store holds either way — an object with
no row belongs to nobody, which is what lets `gc` sweep by row and then delete the
objects those rows named. Scoping the bucket is the HOST's job, because only the host
knows what it is one of.

A wipe drops the rows and leaves the objects, which is what the old wipe did too: the
body is synchronous on purpose (it shares the CAS's transaction) and an object store
can never join one. Dropping the row is what makes the bytes unfetchable; the storage
leaks, as it did before.

It needs one column the seam does not: `written_ms` on `blobs`. Rule 10 puts the
bytes in before the row that names them, and on a server those are two REQUESTS —
a `PUT /blob`, then the `POST /commit` that adopts it, seconds or minutes later.
A sweep in between would collect content the pusher has already ticked off, and
the engine never offers a pushed row's bytes twice, so the row would be a stub
for ever with no peer left that knows to re-send. An hour's grace is far longer
than any push and far shorter than the daily sweep.

### The wake a backend cannot promise, kept by the host that can

Neither `idbStore` nor `sqliteStore` offers `subscribe`, and both are right: the
DATABASE is the store, not the connection, so a wake held in one tab's — or one
process's — closure goes permanently stale for another's commit, and a consumer
takes `subscribe` INSTEAD of polling `since`. But `syncedVolume` arms its push
off exactly that signal, so without one a local write waits out the whole
interval; and `storeVolume`'s watch falls back to polling the feed on a timer.

`store.idb.ts` names the answer and says where it belongs — "a `BroadcastChannel`
beside the commit… where its latency is measured, not here" — so both hosts keep
their own:

- the browser wraps each store in one, which is complete across every tab of the
  origin, so nothing regresses against the raw store's polling;
- the Durable Object wraps its own, which is complete because a DO IS the one
  writer — and the server→client poke becomes an ordinary subscriber instead of a
  special case in the commit path.

`idbStore` also gains `close()`: `indexedDB.deleteDatabase` waits on every open
connection and fires `onblocked` rather than completing, so "forget this browser"
could not delete what it promised to.

### A lane you can rename ACROSS is a lane in the same store

Running the app found this one, and nothing in the task list did: app install
staged its bundle under `/private/tmp/app-installs` and committed it with a
rename into `/applications/<id>`. That worked when `/private` was a path prefix
the old engine filtered — "commit by renaming across the lane boundary" is what
[#379](https://github.com/xiaoxinghu/justfiles/pull/379) chose it for. A mount is
a STORE boundary, so the same rename is `EXDEV`, and every install failed.

Staging moves back into the synced lane (`/system/tmp/app-installs`), because a
rename is the only atomic commit there is and it cannot cross a mount. The wire
objection that moved it out does not survive into this model: a push offers each
row ONCE at its latest state (rule 4), so a subtree staged and renamed inside one
cycle reaches a peer as the finished bundle and nothing else — and content is
hash-keyed, so a cycle that does catch it mid-stage re-sends no bytes when the
rename lands. The old put-then-delete churn was the journal's, not the tree's.

The mac daemon's `/private/tmp/app-assets` needs no change: it renames a FILE,
which is the one thing a cross-mount rename does carry (the bytes).

### `/file/*` is not the seam, and does not live in `store.api.ts`

The CLI reads one file at a time, and over the seam that is a request per path
segment plus a blob fetch. The route survives, reimplemented over the new volume
— but in `file.api.ts`, not in `store.api.ts`, which is the wire and takes no
addition without a design review that starts with "why can this not be rows?".
It reads through a `Volume` and writes nothing, so it can say nothing the seam
does not; it only says it in one request. The host serves it over the UNBOUND
tree, for the same reason `storeApi` is handed the synced store alone.

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

The new name is `/store`. It is a top-level route rather than something under
`/fs`, so the host's auth middleware and its owner routing name it explicitly and
no ordering between two overlapping mounts decides which half a request reaches.
A new top-level prefix on frieren is THREE places, not one: the Worker's
middleware and routing, `run_worker_first` in `wrangler.jsonc` (without it the
asset handler answers a seam call with `index.html`, and a client reads HTML
where it expected JSON), and the PWA's `navigateFallbackDenylist`.

One thing that ordering does NOT close, and it is a deploy window rather than a
design hole: a tab still running the previous bundle keeps writing to `/fs`, and
the one pass has already run. Those writes reach tables nothing reads afterwards.
A reload is what fixes it, and [T18](t18-retire.md) — which deletes the routes —
is what makes the window impossible rather than merely short.

So the task lands as a stack, each PR on the one before it, each green on its
own:

| PR | What | State |
| --- | --- | --- |
| 1 | The decisions: atomic commit + table namespace, the durable discard slot, this order | landed |
| 2 | `/private` is a mount: a store is an id, the announced row, the migration split, the native import filter | landed |
| 3 | The new `/fs` surface beside the old one, and frieren onto it: DO host (two stores, bound), browser client, `apps/cli`, `frieren-auth`, `emptyStore` + the reset on the synchronous seam | landed |
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
