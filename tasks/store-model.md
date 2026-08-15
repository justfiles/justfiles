# Store model — task breakdown

Source design: [kb/fs/fable-design.md](../kb/fs/fable-design.md). Read its
sections #2 (data structures) and #3 (the seam) before you start any task.

Goal: one model. The `Store` seam replaces the twin vocabulary
(`packages/fs` disk-FS model + `packages/sync` sync model). At the end,
`packages/sync` is deleted.

## Do we keep a separate `packages/sync`?

No. The new engine is one small module (`engine.ts`) over the `Store` seam.
It lives in `packages/fs`. Two parts stay outside `packages/fs`:

- The SQLite `Store` backend and the Hono route adapter stay in
  `packages/core`. They are server code. `packages/fs` must stay
  dependency-free; `core` depends on `fs`, never the reverse.
- `packages/sync` is deleted only in the last task, after every consumer
  moved. Until then both models run side by side.

## Ground rules — every task

- RED first. Write the failing test. Run it. See it fail for the right
  reason. Then implement. Then see it pass.
- New code goes into `packages/fs` as NEW files. New files must not import
  the old vocabulary (`storage.ts`, `Ino`, `InodeMeta`, `MutationOptions`).
  The old code keeps working until the swap task.
- Tools: pnpm, vitest, node, tab indentation. Run tests with
  `pnpm vitest run <file>` in the package directory. Run `pnpm typecheck`
  before you finish.
- One branch + worktree per task (see CLAUDE.md). Seed the git-ignored dev
  files listed there.
- Export only what the next task needs. Nothing more.

## Dependency map

```
T1 → T2 → T3 → T4 (kill criterion — do early)
              ↘
T1..T3 → T5 → T6 → T7            (volume)
T1..T3 → T8 → T9 → T10 → T11     (engine)
T1..T3 → T12 (SQLite)  T13 (HTTP) T14 (native FS)
T6 + T13 → T15 (mounts)
T12 + T4 → T16 (migration)
T11 + T13 + T15 + T16 → T17 (swap) → T18 (retire)
```

---

## Phase A — the seam

### T1. Store types + memStore + conformance suite (table, lookups, commit)

**Goal.** The `Store` interface exists, a memory backend implements it, and
a reusable conformance suite proves the core contract.

**Context.** Design #2 and #3: copy the types verbatim (`NodeId`, `Hash`,
`Version`, `Cursor`, `Node`, `Page`, `Guard`, `Store`). Add a `ROOT`
constant. Suite-factory pattern to copy:
`packages/core/src/storage.sqlite.conformance.test.ts` and
`packages/sync/node-conformance.test.ts`.

**Files.** `packages/fs/store.ts` (types + ROOT),
`packages/fs/store.conformance.ts` (exported
`storeConformance(name, open: () => Promise<Store>)`),
`packages/fs/store.mem.ts`, `packages/fs/store.mem.test.ts`.

**RED.** Write the suite for contract rules 1–3 and 6:

- `get(ROOT)` returns a live directory.
- `get`, `child`, `children` behave as two indexes over one table.
- `children` pages in one stable name order; a resumed cursor never skips
  or repeats an entry.
- `child` with two live rows for one `(parent, name)` returns the lowest
  `id` (contract rule 1).
- `commit` is atomic: any failed guard commits nothing, including a batch
  where the last guard fails.
- Both guard kinds work: `free` rejects when a live node holds the name;
  `version` CAS rejects on mismatch; `is: null` means "must not exist".
- Writes replace whole rows. Committing an identical row is a no-op.
- A tombstone (`deleted: true`) frees the name for `free` guards and
  disappears from `child`/`children`.

Run the suite against a stub that throws. All red.

**GREEN.** Implement `memStore()`. Two maps + an array, per the backends
table in the design.

**Done when.** `pnpm vitest run store.mem.test.ts` is green and
`pnpm typecheck` passes.

### T2. The change feed: `since` + cursor lineage

**Goal.** The feed semantics of contract rules 4, 5, and 11, in the
conformance suite and memStore.

**Context.** Design contract rules 4 (self-compacting feed), 5 (cursors are
replica-private), 11 (lineage fencing). Depends on T1.

**RED.** Extend `store.conformance.ts`:

- `since()` from the empty cursor returns every live row and every
  tombstone, paged.
- Each node appears at most once per scan, at its latest committed state.
- An update moves the node to the end of the order: a resumed cursor sees
  it again with newer state; it never permanently misses a node.
- A commit during a paged scan is safe: the changed row reappears later in
  the scan (write mid-scan, keep paging, assert convergence).
- A cursor from a different store instance (new lineage) is rejected with a
  typed error (`ForeignCursorError` or similar — pick one name, export it).
  The caller restarts from the empty cursor and converges.
- `subscribe`, when present, fires once per commit with the committed rows,
  after the commit.

**GREEN.** memStore: a monotonic sequence per commit; `since` scans rows
ordered by their latest sequence; a lineage id minted per store instance,
embedded in the cursor.

**Done when.** Suite green on memStore. No journal rows exist anywhere —
the feed is an index over the one table.

### T3. Blobs

**Goal.** The content map: `has` / `get` / `put` by hash.

**Context.** Design contract rules 7 and 10. Depends on T1. SHA-256 hex via
`crypto.subtle` (see `sha256Hex` in `packages/core/src/fs.ts`).

**RED.** Extend the suite:

- `put` then `get` round-trips; `has` answers without fetching.
- Blobs are immutable: a second `put` under the same hash is a no-op.
- A committed row may reference an absent hash (lazy stub) — `get` returns
  `null`, nothing throws.
- An orphan blob (no referencing row) is allowed to exist.
- Export a small helper `verifiedBlobs(blobs)` that rejects a `put` whose
  bytes do not hash to the key — used later by every peer-facing store
  (rule 7). Test the reject.

**GREEN.** memStore blob map + the helper.

**Done when.** Suite green. The write-ordering rule (blob durable before
row commit — rule 10) is a CALLER rule; it gets its tests in T6 and T9.

### T4. IndexedDB Store — the kill criterion

**Goal.** Prove guarded atomic batch commit inside IndexedDB transaction
rules. The design names this the one structural risk (end of
fable-design.md). Do this before any volume or engine work builds up.

**Context.** Depends on T1–T3. Test setup: `import 'fake-indexeddb/auto'`
FIRST (see `packages/fs/storage.idb.dirty.test.ts` header). Schema per the
design backends table: one object store for nodes with two indexes
(`parent+name`, `seq`), one object store for blobs. Existing IDB idioms:
`packages/fs/storage.idb.ts` (do not import it; read it for patterns).

**Files.** `packages/fs/store.idb.ts`, `packages/fs/store.idb.test.ts`.

**RED.** Run the FULL conformance suite (T1–T3) against `idbStore(name)`.
Add IDB-specific tests:

- All guard evaluation and all writes happen in ONE IDB transaction. No
  `await` of non-IDB work inside the transaction (IDB auto-commits on such
  awaits). Precompute everything before the transaction opens.
- A failed guard in a 100-row batch commits zero rows (reopen the DB and
  count).
- Two overlapping `commit` calls serialize; both guards evaluate against
  committed state.

**GREEN.** Implement. Hash computation, row encoding, everything async
happens BEFORE the transaction.

**Done when.** Suite green under fake-indexeddb. If atomic guarded batches
are impossible within IDB transaction lifetime rules: STOP. Do not work
around it. Report back — the seam must change (design kill criterion).

---

## Phase B — the two consumers

### T5. `storeVolume(store)` — read side

**Goal.** The POSIX read surface over a `Store`.

**Context.** Design table A (access patterns) and the `volume(store)`
section. The `Volume` interface in `packages/fs/volume.ts:38` is the exact
target surface — do not change it. Behavior specs to mirror:
`packages/fs/resolve.test.ts`, `chroot.test.ts`. Depends on T1–T3.

**Files.** `packages/fs/volume.store.ts` (export `storeVolume` for now; the
swap task renames it), `packages/fs/volume.store.read.test.ts`.

**RED.** Against `storeVolume(memStore())`:

- path resolution segment by segment via `child`; symlink follow with a
  hop limit; `stat` vs `lstat`.
- `stat` never calls `blobs.get` (size is on the row — assert with a spy).
- `readdir` full listing via paged `children`.
- `readFile` = row lookup + `blobs.get`; ENOENT/EISDIR errors use the same
  `ENOENT:`/`EISDIR:` message prefixes the old volume uses.
- `readlink` from the inline `link` field; xattr reads from the row;
  `exists`; `scan` walks the tree; `chroot` composes.

**GREEN.** Implement read ops. Upward/downward walks bound themselves with
a visited set (contract rule 9).

**Done when.** Read tests green. No write op exists yet.

### T6. `storeVolume` — write side

**Goal.** Every mutating Volume op as guarded commits.

**Context.** Design table A rows for writes, plus the parent-`mtime` rule
in the `volume(store)` section (it is the concurrency guard for `rm -r`).
Version format: reuse the engine's author-tagged version (T8 defines it;
until then stamp `local:<counter>` — the volume takes a `mintVersion`
function so the engine can inject its own later). Depends on T5.

**RED.** New test file, plus port the intents of `exclusive.test.ts`,
`displace.test.ts`, `append-order.test.ts`, `listdir-vanish.test.ts` to the
new volume:

- `writeFile` create: `blobs.put` resolves BEFORE the row commit (rule 10 —
  assert call order with a spy); the name is claimed with a `free` guard;
  a concurrent create of the same name loses cleanly (EEXIST).
- `writeFile` overwrite: version guard on the file row.
- Every create/delete/rename stamps the parent directory's `mtimeNs` and a
  new parent version, in the SAME commit.
- `mkdir` (+ `recursive`), `appendFile` (read-modify-write), truncate via
  `writeFile`, `chmod`/`utimes` (whole-row replace), xattr writes,
  `symlink`.
- `rename`: exactly three rows committed (node, old parent, new parent) —
  assert commit size; a displaced target becomes a tombstone in the same
  commit.
- **Proof test (design "first proof"): a rename of a directory with 4,000
  children is ONE feed entry for the moved node** (plus the two parents).
  Assert via `since`.
- `rm -r`: enumerate children, commit one batch of tombstones guarded on
  the parent's version; a concurrent create inside the directory makes the
  batch fail; the caller re-enumerates and retries.
- `cp -r`: new ids, reused content hashes, zero `blobs.get` calls for the
  copy itself.

**GREEN.** Implement. Delete-then-create mints a new id; ids are never
rebound.

**Done when.** All write tests green. The feed after any op contains only
whole rows — no partial patch anywhere.

### T7. `watch` from the feed

**Goal.** `Volume.watch` synthesized from committed row diffs.

**Context.** `packages/fs/watch.test.ts` is the behavior spec (burst
folding via `WATCH_BURST_MS`, recursive scoping). Design: watch = row diffs
from the commit feed; effective path via upward parent walk with a visited
set. Depends on T6.

**Event source.** The old model tags events with `MutationOptions.origin`
(`REMOTE_SOURCE` in `packages/sync`). The new model has no origin tags.
Instead: `Version` carries its author replica id (design push-filter
section). A watch event's `source` is derived from the version's author —
`remote` when the author is not this replica, else undefined. Frieren's
`host.ts:295` filter keeps working through this. Write this down in the
code where `source` is derived.

**RED.** Port `watch.test.ts` scenarios to `storeVolume`; add: a row
committed by a foreign author surfaces `source: 'remote'`.

**GREEN.** Implement over `subscribe` when present, else poll `since`.

**Done when.** Watch tests green with both mechanisms (subscribe present
and absent — memStore can hide `subscribe` behind a flag in the test).

### T8. Engine core: pull, push, cursors

**Goal.** `sync(local, remote)` — the whole loop from design #3.

**Context.** Design sync-engine section: pull page → commit → advance
cursor; push rows this replica authored → advance cursor. `Version` =
`{author: replicaId, counter}` encoded as an opaque string; the engine owns
encode/decode, stores never parse it. Cursors live in a host-local slot the
caller injects: `{ load(): Promise<string|undefined>, save(c): Promise<void> }`
— never inside the replicated table, never in the user tree. Depends on
T1–T3 (not on the volume).

**Files.** `packages/fs/engine.ts`, `packages/fs/engine.test.ts`.

**RED.** With two memStores (plus a third for star topology):

- Bootstrap: `since(ø)` pull converges an empty replica; identical rows on
  both sides (the convergence invariant — compare full row sets).
- Steady state is echo-free: after a pull, the next push sends ZERO rows
  (author filter). Assert on commit calls to the remote.
- Idempotence: apply the same page twice — no-ops, same state.
- **Proof test: delete the saved cursor, rerun — every re-applied page is a
  no-op and state is unchanged.**
- Crash resume: advance the cursor only AFTER the batch commits; kill the
  loop between commit and save; rerun; converged.
- **Proof test: a foreign-lineage cursor is rejected; the engine restarts
  from the empty cursor and converges** (uses T2's typed error).
- Star topology: A↔hub, B↔hub; a write on A reaches B.

**GREEN.** Implement the loop. Retries on failure with backoff live here;
keep them dumb.

**Done when.** All green with fake timers where the loop schedules itself.

### T9. Engine: blob transfer + lazy content

**Goal.** Content moves separately from rows, deduplicated, optionally
lazy.

**Context.** Design: "for each new content hash — has? skip : transfer
(lazy where allowed)"; contract rules 7 and 10; "Selective content"
paragraph. Depends on T8.

**RED.**

- Push: for each authored row with a new hash — `remote.blobs.has`? skip :
  `put`. The blob `put` resolves BEFORE the row commit (spy on order).
- A rename/move transfers zero bytes (same hash both sides).
- Pull eager mode: fetch missing blobs after applying rows.
- Pull lazy mode: fetch nothing; export a store wrapper
  `hydratingBlobs(local, remote)` whose `get` falls through to the remote
  and caches locally — `storeVolume(withBlobs(local, hydrating))` reads a
  lazy stub transparently. (Frieren's `lazyContent: true` maps to this.)
- **Proof test: crash between `blobs.put` and `commit` leaves only an
  orphan blob — never a committed row whose bytes are lost.**
- Remote-facing blob writes go through `verifiedBlobs` (T3).

**GREEN.** Implement in `engine.ts` + a small `store.blobs.ts` if the
wrapper needs its own file.

**Done when.** All green; the lazy path never calls `remote.blobs.get`
until a read demands it.

### T10. Authority + conflict policy (reject and replan)

**Goal.** The server-side commit discipline and the client's answer to a
rejection.

**Context.** Design contract rule 9 (tree invariants are the AUTHORITY's),
"Authoritative" and "Conflicts" bullets. v1 policy is reject-and-replan —
no merges. Depends on T8.

**Files.** `packages/fs/authority.ts` (a `Store` wrapper:
`authority(store)`), tests beside it.

**RED.**

- `authority(store).commit` rejects: a duplicate live `(parent, name)`; a
  parent that is not a live directory; a cycle (move a dir under its own
  descendant); a version guard mismatch. Plain `store.commit` accepts the
  same rows (rule 9: replicas may hold detached rows mid-sync).
- A detached cluster on a replica is invisible (T5 resolution) until a
  later row reattaches it.
- Engine replan loop, three scenarios with two replicas and an authority
  hub — write the expected outcome as the test name:
  - edit/edit on one node: the push that lost the race guard-fails; the
    engine pulls, then re-pushes the local edit on the new base; the last
    writer wins at the authority.
  - create/create of one name: the loser's push fails the `free` guard;
    the engine pulls the winner, renames the local node to a deterministic
    conflict name (`name (conflict <replicaId>)`), and pushes that. Both
    files exist everywhere afterwards.
  - edit vs delete: the delete committed first; the editor's version guard
    fails against a tombstone; the engine recreates the file under a NEW
    id with the local bytes (tombstones + versions distinguish this from a
    plain create — the Unison argument in the design).
- POLICY NOTE: these three outcomes are v1 policy, not seam contract. If
  review changes an outcome, only `engine.ts` tests change — assert that no
  `store.ts` type changed in the task diff.

**GREEN.** `authority.ts` + a small replan module inside `engine.ts`.

**Done when.** All green. `Store` and `Guard` signatures unchanged.

### T11. Lifecycle wrapper — the `synced()` replacement surface

**Goal.** The surface Frieren and worker consume today, over the new
engine.

**Context.** `packages/sync/synced.ts` `SyncLifecycle` (line ~86): `flush`,
`pause`, `resume`, `destroy`, `status`, `onStatusChange`, `takeTheirs`,
`takeMine`, `generation`. Consumers: `apps/frieren/src/fs.ts`,
`apps/worker/src/react-app/useVolume.ts`. Depends on T8–T10.

**Files.** `packages/fs/synced.ts` (new one — name it `syncedVolume` until
the retire task), tests.

**RED.** Against memStores:

- status transitions connecting→syncing→synced; error on a failing remote;
  pause stops the loop; resume restarts it; flush runs one push+pull now;
  destroy stops everything.
- Debounced push after local writes (mirror the 3s/15s constants from the
  old `synced.ts`; fake timers).
- `takeTheirs`: discard the local store, bootstrap from `since(ø)`,
  converged.
- `takeMine`: start a new lineage on the authority (maps onto the existing
  generation CAS in `packages/core/src/reset.ts` — the wrapper only needs
  an injected `reset()` capability), re-author every local row, push all;
  a second replica converges to the local baseline.

**GREEN.** Implement as a thin layer: volume + engine + status. No sync
state file in the tree — the `/.state/sync` file of the old model does not
exist here; cursors use the injected slot (T8).

**Done when.** All green; the exported surface is a strict match for what
`apps/frieren/src/fs.ts` consumes (read it and list the members in the
test).

---

## Phase C — backends and wire

### T12. SQLite Store (server)

**Goal.** The authority's durable backend.

**Context.** Design backends table: one `nodes` table (id PK, parent,
name, type, mode, mtimeNs, size, xattrs JSON, content, link, version,
deleted, seq), indexes on `(parent, name) WHERE NOT deleted` and `seq`;
one `blobs` table. Existing SQLite idioms + test setup:
`packages/core/src/storage.sqlite.ts` and its conformance test (do not
import the old one; copy the setup). Guards evaluate in the same
transaction as writes. Depends on T1–T3; independent of Phase B.

**Files.** `packages/core/src/store.sqlite.ts`,
`packages/core/src/store.sqlite.test.ts`.

**RED.** Run the full T1–T3 conformance suite. Add: guard + writes in one
SQL transaction (fail a guard, count rows); `seq` is monotonic across
reopens; lineage id persists across reopens (a reopened store accepts its
own old cursors — this differs from memStore and needs its own test).

**GREEN.** Implement.

**Done when.** Conformance green in the core package's SQLite test
environment. `pnpm typecheck` green.

### T13. HTTP wire: `storeApi` + `httpStore`

**Goal.** A remote peer is just another `Store` (design: the seam IS the
wire).

**Context.** Server pattern: `packages/core/src/fs.ts` (Hono + zod,
bigint-as-string encoding, blob hash verification on PUT — reuse those
helpers' IDEAS, not the routes). Client lives in `packages/fs` (fetch only,
zero deps). Wire shape: `Node` rows verbatim; bigints as decimal strings.
Depends on T1–T3; T10 for mounting `authority()` server-side.

**Files.** `packages/core/src/store.api.ts` (Hono routes over an injected
`Store`), `packages/fs/store.http.ts` (`httpStore(baseUrl, headers?)`),
conformance test wiring them in-process.

**RED.**

- Routes: `GET /node/:id`, `GET /child?parent&name`, `GET /children`,
  `GET /since`, `POST /commit` (rows + guards; a guard failure is a 409
  carrying which guard failed), `GET|HEAD|PUT /blob/:hash` (PUT verifies
  the hash — 400 on mismatch).
- Conformance: run the FULL suite against
  `httpStore` whose fetch is the Hono app's `app.fetch` over
  `store.sqlite` or memStore. The suite passing over the wire is the
  design's central claim — one contract, no capability negotiation.
- A foreign-lineage cursor over HTTP maps to the same typed error (T2).
- The server wraps the store in `authority()` — an invariant-breaking
  commit gets 409, and the engine replan (T10) works over this wire
  end-to-end (one integration test: two `httpStore` clients, one hub).

**GREEN.** Implement both sides.

**Done when.** Conformance + the end-to-end replan test green. No other
route exists on this API — additions need a design review ("why can this
not be rows?").

### T14. Native FS Store (dev server + scripts)

**Goal.** A `Store` over a real directory, so local tools keep working
after retirement.

**Context.** Design backends table, last row: real files + a sidecar
index; `since` = reconcile scan against the sidecar; documented weaker
crash model. Consumers to serve: `packages/app/dev-server.ts`,
`apps/frieren/scripts/frieren-auth.ts` (today they use `fsStorage` /
`memStorage`). Depends on T1–T3. Keep it MINIMAL: an in-memory index
rebuilt by a scan on open plus a JSON sidecar for ids/versions is enough;
do not build inotify integration.

**RED.** Conformance suite against a temp directory. Plus: reopen the
store, ids are stable (sidecar survives); an out-of-band file edit appears
in `since` after the next reconcile scan.

**GREEN.** Implement `packages/fs/store.fs.ts` (node imports allowed in
this one file, mirroring the existing `storage.fs.ts` precedent).

**Done when.** Conformance green; the two consumers can be pointed at it
in T17 without new features.

---

## Phase D — namespace, migration, swap, retire

### T15. Mounts

**Goal.** Local-only data without ignore rules.

**Context.** Design "The namespace" section — read all of it. Depends on
T6 (volume writes) and T13 (to test that a mounted store never syncs).

**RED.**

- A `mount`-type node claims its name via the normal `free` guard; nothing
  else can occupy it; it can never have children in the synced store.
- `storeVolume(store, bindings)` crosses into the bound store during
  resolution; ops inside the mount hit only the bound store.
- An unbound mount reads as an empty read-only directory.
- Cross-store rename: `EXDEV`; the volume's `rename` falls back to
  copy-then-remove (assert both stores' final state).
- Silent binding: an overlay entry `(parentId, name) → store` checked
  before the row lookup; synced rows under that name stay shadowed, their
  blobs are never fetched; removing the binding reveals them intact.
- Sync isolation: run the T8 engine on the outer store only; nothing from
  the mounted store appears in any page or blob request.
- Per-replica content: a synced symlink targeting a path inside a local
  mount resolves to different bytes on two replicas (the `/etc`
  convention).

**GREEN.** Mount crossing inside `volume.store.ts`; bindings are plain
constructor data, no policy module.

**Done when.** All green. Grep the diff: no glob, no path-prefix config,
no "ignore" identifier anywhere.

### T16. Data migration

**Goal.** One pass: old twin-model data → `Node` rows. Ids survive.

**Context.** Design "Relation to the current code": every syncing backend
already mints `Ino` as a UUID (`storage.mem.ts:64`, `storage.idb.ts:405`),
so `id` = existing ino. Join each inode with its dirent → one row.
Sources: client IDB (`packages/sync/storage/idb.ts` schema — the journaled
one Frieren uses, DB names `frieren-fs-profile-*`) and server SQLite
(`packages/core/src/storage.sqlite.ts` schema + `migrations/`). Depends on
T4 and T12.

**RED.**

- Build a fixture through the OLD stack (volume writes over old
  idbStorage/sqlite), run the migration, open with the NEW store: same
  tree via `storeVolume`, same ids, same content hashes, blobs present.
- Old journal rows, snapshot sessions, and sync-state files (`/.state/*`)
  are dropped, not migrated. `/.state` itself does not exist after
  migration.
- Version stamping: migrated rows get a server-authored version on the
  server, a `migrated` author on clients — so the first client push after
  migration sends ZERO rows (author filter), and the first pull no-ops on
  identical rows. Test exactly that: migrated client + migrated server
  sync with zero row transfers and zero blob transfers.
- The migration is idempotent: run it twice, same result.

**GREEN.** `packages/fs/migrate.idb.ts` (old IDB → `store.idb`, as an IDB
version upgrade or a copy-then-swap of DB names — pick copy-then-swap, it
is resumable) and a core migration for SQLite.

**Done when.** All green, including the zero-transfer convergence test.

### T17. Swap the consumers

**Goal.** Every app runs on the new model. Old model no longer referenced
by apps.

**Context.** The full consumer list (verified against imports):

- `apps/frieren/src/fs.ts` — `idbStorage`→`idbStore` (+ migration on
  open), `synced()`→`syncedVolume` (T11), reset plumbing onto the injected
  `reset()` capability.
- `apps/frieren/src/apps/host.ts:295` — `REMOTE_SOURCE` import replaced by
  the T7 event-source rule (export a `REMOTE_SOURCE` constant from
  `packages/fs` so the diff stays small).
- `apps/worker/src/react-app/useVolume.ts` — same swap; its `apiStorage`
  remote becomes `httpStore`.
- `apps/cli/src/volumes.ts:100` — `volume(await apiStorage(client))` →
  `storeVolume(httpStore(...))`.
- `packages/core/src/fs.ts` — mount `store.api.ts`; keep only the
  convenience routes with consumers outside the sync stack (`/file/*`,
  `/inodes/:ino/content/:filename`) reimplemented over the new volume;
  delete the rest behind the swap.
- `packages/app/dev-server.ts`, `apps/frieren/scripts/frieren-auth.ts` —
  `fsStorage`/`memStorage` → T14/T1 stores.
- `packages/core/src/*.test.ts` files importing `@justfiles/sync`.

Depends on T11, T13, T15, T16. Split this task per consumer if two agents
work in parallel — each bullet is independently landable behind the old
code staying in place.

**RED.** Each consumer's own existing test suite is the red bar: point the
consumer at the new stack; run the package's tests (`pnpm vitest run` in
the package, plus the `testing` skill flow for Frieren UI).

**GREEN.** Mechanical swaps; no behavior change on the Volume surface is
expected — a needed behavior change is a finding to report, not to absorb
silently.

**Done when.** `pnpm typecheck` and every package's tests green;
`grep -r "@justfiles/sync" apps packages --include=package.json` shows only
`packages/sync` itself.

### T18. Retire the twin vocabulary

**Goal.** One model remains.

**Context.** Depends on T17 fully landed and released.

**Do.**

- Delete `packages/sync` entirely. Remove it from the workspace and from
  every `package.json`.
- In `packages/fs`: delete `storage.ts`, `storage.mem.ts`,
  `storage.idb.ts`, `storage.fs.ts`, `storage.shared.ts`, the old
  `volume.ts` internals, and their tests. Rename `storeVolume`→`volume`,
  `syncedVolume`→`synced`, `store.*` files to their final short names.
  Re-export the final surface from `index.ts` — keep it as small as
  today's.
- In `packages/core`: delete the retired routes in `fs.ts`, `apiStorage` /
  `remoteSyncReplica` in `fs.client.ts`, the old `storage.sqlite.ts` node
  and journal machinery, and dead migrations guards.
- Update `docs/app.md` and any kb docs that name the old vocabulary.

**Done when.**

- `grep -rn "InodeMeta\|MutationOptions\|SyncNodeId\|JournaledStorage\|@justfiles/sync"
  packages apps --include="*.ts"` (excluding node_modules/dist) returns
  nothing.
- Full repo: `pnpm typecheck` and `pnpm -r test` (or turbo equivalent)
  green.
- The final `packages/fs` file list matches the design's final form: one
  table, two lookups, one order, one guarded atomic write, one blob map —
  and the engine, volume, authority, and backends over it. Nothing else.
