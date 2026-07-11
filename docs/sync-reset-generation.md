# Sync reset & generations (server-coordinated volume reset)

Status: implemented. Companion to [`docs/path-based-sync.md`](./path-based-sync.md)
(the sync engine) and [`docs/app-materialization.md`](./app-materialization.md)
(single-origin materialisation). Those make sync *identity* correct; this doc adds
a server-coordinated way to deliberately throw a volume away and re-establish it —
"take theirs", "take mine", and "factory reset" — without forking replicas or
racing other devices.

## TL;DR

The unit of sync is the **whole volume**: apps under `/applications/*`, agent
soul/profile/sessions under `/system/*`, user data everywhere else — all files,
no carve-outs. A reset targets the entire volume.

Three destructive actions, initially **debug-gated**, eventually shippable behind
heavy confirmation:

1. **Reset local ("take theirs")** — discard this device's local replica, re-pull
   the server's volume.
2. **Reset server ("take mine")** — discard the server's volume, republish this
   device's local as the new baseline; every other device re-pulls it.
3. **Factory reset ("wipe both")** — discard server *and* local; start empty
   (client re-materialises built-ins per `app-materialization.md`).

The naïve version (three buttons that stop sync, mutate a side, resume) is unsafe
on more than one device: with no coordination point, a stale device re-pushes
deleted data and clobbers the reset, and a device pulling a wiped server can't
tell "empty" from "not yet loaded".

The coordination primitive is a monotonic **`generation`** (epoch) owned by the
server, surfaced in the handshake and used as a **fencing token** on writes. A
reset bumps the generation; every other device notices the mismatch on its next
handshake and runs a **client reset** (discard-local, re-bootstrap); a device
still on the old generation is **rejected on write** so it can't clobber the new
baseline. This is **pull/handshake-driven, not a command queue**: the client
re-derives "I must reset" every sync until its stored generation matches the
server's — idempotent, offline-safe, no per-device server state.

The reset itself is a **small atomic server op** (truncate + bump). The "take
mine" republish then rides the **ordinary sync loop** — the initiator re-tags its
local as *mine* and lets the normal push drain — so it is resilient to closed
tabs, dropped networks, and multi-hour syncs, and other devices converge to the
new baseline as it fills in (**eventual consistency**, single-user/multi-device).
There is no publishing lock and no finalize step. A small advisory **`resetId`**
flag ("a reset is in progress") rides the handshake for crash-resume identity and
UI legibility — it is *not* a write lock.

## Prior art

Mature multi-device sync converges on "instance/lineage identity +
resync-on-mismatch", separating the *correctness* signal (pulled) from the
*promptness* signal (pushed).

- **Microsoft Graph delta query** — pull `deltaToken`; `410 Gone` ⇒ client
  restarts a full sync. Notifications are a separate push channel.
- **CouchDB** — the peer **Server UUID** feeds the *Replication ID*; a new UUID or
  lost ancestry ⇒ full replication.
- **Litestream** — a **generation** (random hex) names a snapshot+WAL lineage; any
  break starts a new one. Our `generation` almost verbatim; keeping the *old*
  generation around is the (deferred) undo.
- **Replicache / Zero** — a server-controlled **cookie** = a global version of the
  backend state; a **poke** = a contentless "pull now"; `ClientStateNotFound` ⇒
  the client resets. (Poke == our caps-socket `dirty` nudge.)
- **MongoDB Atlas Device Sync** — first-class **client reset**; we ship the
  `DiscardUnsyncedChanges` mode (recover/merge is deferred).
- **Kafka** — `OffsetOutOfRange` ⇒ offset reset; **leader-epoch fencing** stops
  stale actors after a truncation. Our generation is the epoch fence.
- **Fencing tokens** (Chubby / ZooKeeper; Kleppmann, *DDIA*) — a monotonic token
  the resource checks so stale holders are rejected. Our generation on writes.
- **Git** — non-fast-forward is rejected; `--force` rewrites and everyone else
  `reset --hard`. "Take mine = force-push; others reset." `reflog` is the undo we
  defer to a backup.

In-repo, `path-based-sync.md` already keeps a `negotiate()` handshake seam
(`GET /fs`) for schema/protocol bumps; `generation` is the volume-level form of
that "your cursor is invalid — resync" signal.

## Why pull/handshake beats a command queue

A per-device "you must wipe" outbox the client drains is worse on every axis:

- **Idempotent & self-healing** — the client re-derives the decision every
  handshake until it matches; no acks, ordering, dedup, or redelivery.
- **Offline-safe** — a device dark for a month just learns on reconnect; a queue
  needs TTLs, expiry, replay.
- **No per-device server state** — the server keeps one number (+ one advisory
  id), not an outbox.
- **Fencing is free** — the same generation that triggers a reset also rejects
  stale-generation writes, killing the clobber race.

## Why this fits Frieren

- **The account's server is a single Durable Object.** DOs are single-threaded, so
  the generation is one counter mutated serially — no distributed consensus.
- **The handshake and its seam exist.** `GET /fs` returns `{ rootIno,
  protocolVersion, schemaVersion }`; `synced.ts`'s `negotiate()` was the
  placeholder — we added `generation` (+ the advisory `resetId`).
- **The poke exists.** The caps-socket `dirty` → `flushActiveVolume()` makes the
  next pull prompt.
- **The state slot exists.** Cursors live in `/.state/sync` (local-only); the
  `generation` and the in-flight `pendingReset` live beside them.
- **The republish is just sync.** The engine already pages, retries with backoff,
  pauses/resumes on offline/online, flushes on `pagehide`, and resumes from a
  persisted cursor. "Take mine" reuses all of it instead of a bespoke push.

## The model

### The generation

A single **monotonic integer**, persisted in the DO as a **SQLite row** (a row,
not DO-KV, so its bump commits in the same transaction as the truncate),
initialised once (e.g. `1`) and **bumped only by a reset**. It names the server
volume's *lineage*, not its content: a bump means "the volume you knew is gone;
re-establish from scratch". The client persists the generation it last agreed with
in `/.state/sync`:

```ts
type SyncState = {
  schemaVersion: number
  generation?: number    // server lineage this replica is synced against
  pendingReset?: {        // in-flight "take mine" (crash recovery)
    resetId: string       // client-minted id for this reset attempt
    fromGeneration: number // the lineage the reset started from
    toGeneration?: number  // the lineage it produced; set once confirmed (= prep done)
  }
  pushCursor?: SyncCursor
  pullCursor?: SyncCursor
}
```

### The `resetId` (advisory in-progress flag)

The `fs_generation` row carries one more field: `resetId`, the client-minted id of
the reset that produced the current generation. It is **set** by the reset and
**cleared** by an advisory `complete` call once the initiator's republish drains.
It is **not a write lock** — no write is admitted or rejected on the basis of it.
It has two jobs:

- **Crash-resume identity** — a crashed "take mine" initiator uses it to recognise
  *its own* reset on reboot (resume) versus one another device made (take theirs).
- **UI legibility** — other devices read it off the handshake to show "receiving a
  new baseline…" instead of a scary empty desktop, and to grey out their own reset
  button while one is in flight.

A stuck `resetId` (initiator died right at the finish line) is **cosmetic**:
clients still sync and converge. A returning initiator self-heals it; any later
reset overwrites it.

### Handshake check (correctness, pulled)

`GET /fs` returns `generation` plus the current `resetId`; pull payloads
(`DeltaPage` / `ScanPage`) echo `generation` so a mismatch is caught mid-session
without an extra round-trip. Each sync cycle, with no in-flight `pendingReset`,
compares the server's `generation` to the stored one:

- **equal** → normal push/pull.
- **stored undefined** — split by the cursors, since undefined ≠ fresh:
  - **no cursors** (truly fresh replica) → bootstrap, then record the generation.
  - **has cursors** (a replica that synced before `generation` existed) →
    **migration, not reset**: adopt the server's generation and continue.
- **stored ≠ server** (both defined) → the server lineage changed → run the
  client-reset policy (discard-local, re-bootstrap), then record the new
  generation.

With an in-flight `pendingReset`, the handshake instead runs the crash-resume
classifier (see "Reset server").

### Push fencing (anti-clobber, pushed)

Every **mutating `/fs` request** carries the client's known generation
(`x-fs-generation`) — not just path-sync push. `createFsApi` also exposes
inode/xattr/rename/dirent/blob mutation routes, used by the CLI and `frieren-auth`
via `apiStorage` (the inode-level HTTP backend); fencing only path-sync would
leave those as an unfenced back door. A **present-but-stale** generation is
rejected with `409 { error: 'generation_stale', generation: <current> }`; the
client treats it like a handshake mismatch (reset, then retry). An **absent**
header (a legacy/unaware client) is allowed — backward compatible. The reset
routes are exempt (they self-guard via the CAS).

The check is a **mount-level middleware fast-reject**. Folding it into the same
SQLite transaction as the write is the ideal (a bump can't then interleave between
check and commit), but that awaits the DO adapter's `transaction()` becoming real
(see "Known limitations"); until then the DO's single-threading provides the
guarantee in practice. There is **no publishing-lock check** — a "take mine"
republish is ordinary sync at the new generation and passes this same stale check
with no special header.

### Reset endpoint

Auth-guarded DO routes, outside `createFsApi` (they need DO-level powers: truncate
the volume, bump the counter):

```
POST /fs/reset { mode:'adopt-mine'|'wipe', fromGeneration:N, resetId? }
  -> 200 { generation: N+1 }
  -> 409 { error: 'generation_stale', generation: <current> }
  # resetId identifies the reset (in-progress flag); required for adopt-mine

POST /fs/reset { mode:'complete', resetId }
  -> 200 { generation }        # advisory: clear the in-progress flag if it's still `resetId`
```

`fromGeneration` makes the bump a **compare-and-swap** — the DO applies only if
`N === current`, so racing resets can't interleave or double-bump; the loser is
told it's stale and resets to the winner. "Take theirs" needs no endpoint
(client-only). `complete` has **no CAS/owner rigor** — a stale/duplicate/never-sent
clear is a harmless no-op. The DO must guarantee:

- **One atomic SQLite transaction for the reset.** The reset — CAS check, truncate
  the tree (`fs_inodes` / `fs_dirents` / `fs_xattrs`) and **both sync tables**
  (`fs_path_journal` and `fs_path_version`; the latter's `tombstone_version` would
  otherwise make a re-published put lose its LWW check), recreate the root inode,
  bump `generation`, store `resetId` — runs in one transaction, so a crash leaves
  either the old lineage or the new one, never a mix. `ensureBootstrapped` seeds
  the root inode once per DO lifetime and caches that it ran, so the reset must
  recreate root `ino=1` (a fresh `volume()` handle then sees the truth). Content
  tables are mode-specific (see Wipe scope).
- **Quiesce the server's own writers.** Fencing `/fs` stops only HTTP mutations;
  the DO also writes `this.vol` directly (agent session, app capabilities,
  `ensureAgentDefaults`, daily-alarm maintenance), bypassing every `/fs` route. A
  reset rebuilds the cached `this.vol`; a mid-turn agent write racing the truncate
  is an integration concern (the reset is debug-gated for now).

### The republish rides ordinary sync

This is the core of the design. After the server reset bumps to `N+1`, the "take
mine" initiator does **not** run a bespoke snapshot push. It:

1. **Re-tags its local journal as mine.** The server is now empty, so every local
   file *is* locally-owned — `caps.journal.adoptAllAsLocal()` clears every row's
   `localSource`. The ordinary push filters `excludeLocalSource: REMOTE_SOURCE`
   (echo suppression), which would otherwise drop exactly the files this device
   *pulled* from the old server; re-tagging makes them mine, so the push includes
   the whole volume. This is *truthful*, not a trick: the remote they came from is
   gone.
2. **Rewinds `pushCursor`** to replay the (now all-mine) journal, and keeps
   `pullCursor` defined so the loop republishes rather than bootstrapping.
3. **Records `N+1`** as the agreed generation.

Then the **normal sync loop** drains the push over as many cycles as it takes —
resilient (survives tab-close/offline, resumes from the persisted `pushCursor`)
and unbounded (a multi-hour/day sync just happens in the background). The cost of
replaying the journal is metadata churn, not bytes: `uploadBlobs` short-circuits
on `hasBlobByHash`, and `adopt-mine` keeps the server's content blobs so
lazily-held files still resolve. (Coalescing the journal into a fresh baseline to
avoid the history replay is a future optimisation.)

When the drain reaches the journal head (nothing left to push), the client fires
`onResetComplete(resetId)` → `POST /fs/reset { mode:'complete', resetId }` to clear
the advisory flag, and drops its `pendingReset`.

### Client-reset policy

Start **discard-only** ("take theirs"): on a mismatch, drop the local replica +
cursors and re-bootstrap against the current generation (Atlas's
`DiscardUnsyncedChanges`). `RecoverUnsyncedChanges` (re-apply this device's
local-only edits onto the new baseline) is the hard, CRDT-ish path — deferred.

## The three operations

Let the current server generation be `N`.

**Reset local ("take theirs")** — no bump. The client discards its local replica +
cursors and re-bootstraps against `N`. Purely client-side; the common, safe case.
(For a local-only profile with no server, just wipe local IDB + reload.)

**Reset server ("take mine")** — the initiator:

1. persists `pendingReset { resetId, fromGeneration: N }` **before** the CAS (so a
   crash can't discard the volume it means to publish);
2. `POST /fs/reset { mode:'adopt-mine', fromGeneration:N, resetId }` → the DO
   truncates the server tree + sync tables (keeping content blobs), bumps to `N+1`,
   stores `resetId`;
3. **adopts locally** — records `N+1`, re-tags the journal as mine, rewinds
   `pushCursor`, sets `pendingReset.toGeneration = N+1`;
4. the ordinary loop **republishes**; on drain it `POST`s `complete` and drops
   `pendingReset`.

Other devices see `N+1` and client-reset, then pull the new baseline **as it fills
in** (eventual consistency). Stragglers on `N` are fenced. This is git force-push,
others `reset --hard`, made safe by the generation.

- **Eventual-consistency trade.** Other devices switch to `N+1` immediately and may
  show a **transient partial/empty volume** while a slow republish catches up. The
  initiator holds the full truth and converges whenever it is online; a
  permanently-abandoned initiator leaves the fleet partial. Mitigations: the
  advisory `resetId` (UI legibility + reset-button gating), and the deferred
  backup/undo (see Open questions). This is the deliberate trade for "the republish
  can take hours and survive a closed tab."
- **Crash recovery — pure client logic in the handshake reconcile**, keyed on
  `resetId` + `generation` (no bespoke resume orchestration; the republish itself
  resumes from the persisted `pushCursor`):
  - **resume** — `server.resetId === pending.resetId`: our reset is the current
    lineage; finish local prep if the crash interrupted it (idempotent), then keep
    draining.
  - **adopt** — our reset's `toGeneration` is the current generation and the flag is
    cleared (republish completed), *or* the reset never landed (`server.generation
    === fromGeneration`): keep local, adopt the generation, drop the intent.
  - **reset-to-winner** — a newer/other `resetId` owns the server: a different reset
    won, so client-reset to its baseline.

**Factory reset ("wipe both")** — `POST /fs/reset { mode:'wipe', fromGeneration:N }`.
The DO truncates the volume (including content tables — see Wipe scope) and bumps
to `N+1`. The initiator discards local + re-bootstraps into the now-empty server;
materialisation reseeds built-ins and pushes them as the `N+1` baseline over
ordinary sync. Other devices reset to that baseline. No `pendingReset` is needed —
a crash just leaves the initiator client-resetting into the empty server and
reseeding, which is the intended outcome.

## Wipe scope

The entire volume — no carve-outs. Apps, agent soul/profile/sessions, and user
data are all files; sync treats the volume uniformly, so reset does too. Points to
be explicit about:

- **Blobs & content tables are mode-specific.** `wipe` drops the `fs_contents` rows
  **and the `fs_content_fts` index** — `/fs/blob/:hash` serves straight from a
  `fs_contents` row and FTS5 retains extracted text, so keeping them would leave
  wiped content fetchable/searchable by any client that knows a hash, defeating a
  factory reset. `adopt-mine` **keeps** both (the republish reuses lazy blobs the
  user never downloaded). The discarded baseline's now-orphaned blobs are reclaimed
  by a **lazy/scheduled `gcUnreferenced` sweep**, decoupled from the reset (there is
  no finalize step to hang it on). R2 bytes are always left orphaned for the sweep;
  deleting inline is riskier with shared hashes.
- **Server-seeded agent defaults reseed, so "empty" is short-lived.** The DO
  constructor's boot path runs `ensureAgentDefaults()`, seeding `/system/soul.md` +
  `/system/profiles/user.md` when absent. `POST /fs/reset` truncates in place, so
  the volume is momentarily empty, but the next DO restart reseeds those two files.
  Factory reset converges to *seeded defaults*, not a literally bare volume.
  `adopt-mine` does **not** reseed at reset time (the initiator republishes its own
  `/system/*`); the next restart reseeds only what is still missing.
- **The `/.state/materialised` app-seed marker is mode-sensitive.** `seedBuiltins`
  seeds built-in apps at most once per replica, gated by this local-only marker.
  A client-reset that wipes IDB deletes the marker, so:
  - **Factory reset** leaves it unset — the server is intentionally empty and we
    *want* the client to reseed built-ins and push them.
  - **Take-theirs / client-reset** sets it after bootstrap — adopt the server
    verbatim, or an intentionally-emptied server looks "new" and gets built-ins
    reseeded and pushed back.
  - **Take-mine** keeps local intact, so its republished `/applications/*` already
    carries the apps; other devices pull them on client-reset.
- **Non-volume DO state** (the `AuditLog` in `ctx.storage`, in-memory rate-limit
  buckets) is out of scope — it never syncs, so a volume reset neither reads nor
  clears it.

## Where the UI lives

Shell-level, not the sandboxed Settings app (`app.frieren.settings`), which can't
reach IDB, the sync lifecycle, or `location.reload()`. A small shell panel (like
`PersonalizePanel`), launched from the desktop context menu. "Take theirs" / "take
mine" are gated to **synced** profiles; a local-only profile only offers
factory-reset-local. The panel should read the handshake's `resetId`: while a
reset is in progress, other devices show "receiving a new baseline…" and disable
their own reset actions (so a transient-empty desktop isn't mistaken for a broken
one and re-reset).

## Rollout

- **Now:** debug-gated (a dev-only shell affordance) to reproduce/repair forked or
  wedged replicas during development.
- **Later:** prod behind heavy confirmation — typed-to-confirm, a "this deletes
  everything on all your devices" warning for take-mine / factory reset, and the
  `resetId`-driven "receiving a new baseline" affordance above.

## Non-goals / open questions

- **Recover mode** (merge local-only edits onto the new baseline) — deferred; see
  Client-reset policy.
- **Generation granularity** — one per account/DO. Per-subtree generations are
  overkill and not planned.
- **Concurrent resets** — resolved by the `fromGeneration` CAS and the per-reset
  `resetId`: the loser is told it's stale and resets to the winner's baseline.
- **Partial failure** — the reset is one atomic SQLite transaction, so it can't
  tear (once `transaction()` is real). The republish is now ordinary idempotent
  sync, so an interruption just resumes from the persisted `pushCursor` — no
  special partial-failure handling, no publishing lock, no finalize.
- **Backup / undo (deferred)** — a pre-reset snapshot (a Cloudflare DO
  point-in-time bookmark, or a metadata shadow of the tree since `adopt-mine`
  already keeps the blobs) would let an abandoned take-mine be rolled back. To keep
  the generation monotonic, an "undo" is modelled as a *forward* reset: restore the
  pre-reset baseline as a **new** generation `N+2`. This is the "recover instead of
  prevent" complement to eventual consistency — the safety net that lets other
  devices switch immediately without a lock. Not implemented.
- **Orphaned-blob GC (open)** — `adopt-mine`'s discarded baseline leaves orphaned
  blobs. With no finalize step, `gcUnreferenced()` needs a lazy/scheduled home
  (e.g. piggyback the daily alarm); not yet wired.
- **DO transaction atomicity (known limitation)** — `apps/frieren/worker/db.do.ts`'s
  `transaction()` is still a no-op (`await fn(adapter)`; Cloudflare's SQL API
  rejects manual `BEGIN`/`COMMIT`, and `ctx.storage.transactionSync` needs a
  synchronous body). The reset's crash-atomicity and the fold-fence-into-the-write
  are proven on the core `BEGIN/COMMIT` adapter (`db.sqlite.ts`) but not on the
  shipping DO adapter; the DO's single-threading is the practical guarantee until a
  sync-storage refactor makes `transaction()` real.
- **Stuck `resetId` flag** — cosmetic (not a lock): a returning initiator self-heals
  it, any later reset overwrites it. No lease needed.

## Suggested build order

The implemented layering, cheapest-and-most-defensive first:

1. **`generation` in the handshake + `/.state/sync`; client-reset-on-mismatch
   (discard-only), including the migration case (has-cursors-no-generation →
   adopt).** Hardens the normal path against a server restore-from-backup — worth
   having even before the buttons.
2. **Push fencing** — `x-fs-generation` on every mutating `/fs` route (path-sync
   and the inode `apiStorage` client); `generation_stale` → reset; reset routes
   exempt.
3. **`POST /fs/reset`** as one SQLite transaction: CAS + truncate tree +
   `fs_path_journal` + `fs_path_version` + recreate root + bump + store `resetId`.
   Content is mode-specific — `wipe` also drops `fs_contents` + `fs_content_fts`;
   `adopt-mine` keeps them. Wire "take theirs" (client-only) too.
4. **Take-mine over ordinary sync** — the `adoptAllAsLocal()` journal cap +
   `adoptTakeMine` (re-tag + rewind), the crash-resume classifier in the handshake
   reconcile, and the advisory `resetId` flag with `POST /fs/reset {mode:'complete'}`
   fired on drain.
5. **Shell UI + re-materialisation** — debug-gated panel + confirmations, and the
   `/.state/materialised` marker per mode (factory reset leaves it unset → reseed +
   push; take-theirs sets it → adopt verbatim; take-mine keeps local, which already
   carries `/applications/*`). No new materialisation code — it is the existing
   `seedBuiltins` boot path.

Not touched: the path-sync wire beyond the additive `generation` field; per-file
identity is `path-based-sync.md`'s job. This doc is the volume-level lineage
identity on top of it.

## Testing

The rule of thumb: **the engine logic and the reset transaction body are unit
tests; the crash-atomicity *guarantee*, the agent-turn race, and the UI are not.**
Test the code path everywhere; where a property only holds under true concurrency
or a real crash, cover it by construction (single-threaded DO, atomic transaction)
plus a fault-injection path test.

### Seams to build on (in-tree)

- **`packages/fs/synced.test.ts`** drives the REAL `synced()` engine over
  `memStorage`, with a controllable fake `SyncReplica` server that reports a
  `generation` + advisory `resetId` on its handshake and echoes the generation on
  pull/scan pages. Home for the handshake branch, the take-mine republish, and the
  crash-resume classifier.
- **`packages/core/src/reset.test.ts`** drives the reset primitives (`decideReset`
  CAS, `resetVolume`, `clearReset`) against a REAL `BEGIN/COMMIT` adapter over
  `node:sqlite` — the same transport the sqlite conformance suite uses, so reset
  atomicity runs under vitest with no bun / Cloudflare runtime.
- **`packages/core/src/fs.fence.test.ts`** drives a real `FsClient` against a real
  `createFsApi` app in-process, so the client stamps real headers and the server
  runs its real fence middleware (both client paths: path-sync + inode `apiStorage`).

### Covered

1. **Handshake + client-reset.** The branch table: `equal` → normal; `stored
   undefined` split by cursors (no cursors → bootstrap+record; **has cursors →
   adopt, NOT reset** — the migration case); `stored ≠ server` → client-reset then
   record. Mismatch mid-session via a pull page echoing a different generation.
2. **Push fencing.** Both client paths carry `x-fs-generation`; a `409
   generation_stale` is treated like a handshake mismatch (reset, then retry). A
   server-side stale write is rejected and does not land; a current-generation
   write commits; an absent header is allowed; the advisory `resetId` does **not**
   fence a write.
3. **Reset primitives.** `decideReset` CAS (applies only at `N`); `resetVolume`
   truncates tree + sync tables and leaves a working root (regression for the
   `ensureBootstrapped` cache); `wipe` drops content + FTS (a blob/FTS lookup misses
   after); `adopt-mine` keeps content + records the in-progress `resetId`;
   throw-mid-transaction rolls the whole reset back (atomicity path, on the core
   adapter); `clearReset` clears only the matching id and is idempotent.
4. **Take-mine + crash-resume (engine).** `adoptTakeMine` re-tags + rewinds so the
   ordinary push republishes the whole volume (pulled files included — assert both
   survive), and the drain fires `onResetComplete`. Crash-resume table: `resume`
   (our reset still owns the server → finish prep + republish, not a bootstrap);
   `adopt` (completed / never-landed → keep local + adopt); `reset-to-winner` (a
   newer/other reset → client-reset to it).

### Not unit-tested (by construction / integration)

- **Crash-atomicity on the shipping DO adapter** — `transaction()` is a no-op;
  proven on the core `BEGIN/COMMIT` adapter, guaranteed on the DO by
  single-threading. Awaits the sync-storage refactor.
- **The DO's own `this.vol` writers** vs. an in-flight agent turn racing the
  truncate — DO lifecycle + a live turn.
- **The eventual-consistency window** (a device showing a transient partial volume
  mid-republish) and the **shell UI panel** — per `AGENTS.md`, Frieren UI changes
  get LLM-driven `verify:ui` smoke checks, not unit/e2e tests.
