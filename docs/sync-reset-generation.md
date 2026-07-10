# Sync reset & generations (server-coordinated volume reset)

Status: proposal / design. No code yet. Companion to
[`docs/path-based-sync.md`](./path-based-sync.md) (the sync engine) and
[`docs/app-materialization.md`](./app-materialization.md) (single-origin
materialisation). Those make sync *identity* correct; this doc adds a
server-coordinated way to deliberately throw a volume away and re-establish it —
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

The fix is a monotonic **`generation`** (epoch) owned by the server, surfaced in
the handshake and used as a **fencing token** on writes. A reset bumps the
generation; every other device notices the mismatch on its next handshake and
runs a **client reset** (discard-local, re-bootstrap); a device still on the old
generation is **rejected on write** so it can't clobber the new baseline. This is
**pull/handshake-driven, not a command queue**: the client re-derives "I must
reset" every sync until its stored generation matches the server's — idempotent,
offline-safe, no per-device server state.

## Prior art

Mature multi-device sync converges on "instance/lineage identity +
resync-on-mismatch", separating the *correctness* signal (pulled) from the
*promptness* signal (pushed).

- **Microsoft Graph delta query** — pull `deltaToken`; `410 Gone` ⇒ client
  restarts a full sync. Notifications are a separate push channel.
- **CouchDB** — the peer **Server UUID** feeds the *Replication ID*; a new UUID or
  lost ancestry ⇒ full replication.
- **Litestream** — a **generation** (random hex) names a snapshot+WAL lineage; any
  break starts a new one. Our `generation` almost verbatim.
- **Replicache / Zero** — a server-controlled **cookie** = a global version of the
  backend state; a **poke** = a contentless "pull now"; `ClientStateNotFound` ⇒
  the client resets. (Poke == our caps-socket `dirty` nudge.)
- **MongoDB Atlas Device Sync** — first-class **client reset** with modes
  DiscardUnsyncedChanges / RecoverUnsyncedChanges / RecoverOrDiscard / Manual —
  the take-theirs / merge / take-mine menu.
- **Kafka** — `OffsetOutOfRange` ⇒ offset reset; **leader-epoch fencing** stops
  stale actors after truncation.
- **Fencing tokens** (Chubby / ZooKeeper; Kleppmann, *DDIA*) — a monotonic token
  the resource checks so stale holders are rejected. The anti-clobber primitive.
- **Git** — non-fast-forward is rejected; `--force` rewrites and everyone else
  `reset --hard`. "Take mine = force-push; others reset."

In-repo, `path-based-sync.md` already keeps a `negotiate()` handshake seam
(`GET /fs`) for schema/protocol bumps; `generation` is the volume-level form of
that "your cursor is invalid — resync" signal.

## Why pull/handshake beats a command queue

A per-device "you must wipe" outbox the client drains is worse on every axis:

- **Idempotent & self-healing** — the client re-derives the decision every
  handshake until it matches; no acks, ordering, dedup, or redelivery.
- **Offline-safe** — a device dark for a month just learns on reconnect; a queue
  needs TTLs, expiry, replay.
- **No per-device server state** — the server keeps one number, not an outbox.
- **Fencing is free** — the same generation that triggers a reset also rejects
  stale-generation writes, killing the clobber race.

## Why this fits Frieren

- **The account's server is a single Durable Object.** DOs are single-threaded, so
  the generation is one counter mutated serially — no distributed consensus.
- **The handshake and its seam exist.** `GET /fs` returns `{ rootIno,
  protocolVersion, schemaVersion }` and `synced.ts`'s `negotiate()` is a ready
  placeholder — add `generation`.
- **The poke exists.** The caps-socket `dirty` → `flushActiveVolume()` makes the
  next pull prompt.
- **The state slot exists.** Cursors live in `/.state/sync` (local-only); add
  `generation` beside them.

## The model

### The generation

A single **monotonic integer**, persisted in the DO as a **SQLite row** (see Reset
endpoints for why a row and not DO KV), initialised once (e.g. `1`) and **bumped
only by a reset**. It names the server volume's *lineage*, not its content: a bump
means "the volume you knew is gone; re-establish from scratch". The client
persists the generation it last agreed with in `/.state/sync`:

```ts
type SyncState = {
  schemaVersion: number
  generation?: number    // server lineage this replica is synced against
  pendingReset?: {        // in-flight "take mine" (crash recovery)
    resetId: string       // client-minted id, matched against the server's
    mode: 'adopt-mine'
  }
  pushCursor?: SyncCursor
  pullCursor?: SyncCursor
}
```

### Handshake check (correctness, pulled)

`GET /fs` returns `generation` plus the current `resetId` and a `publishing` flag;
pull payloads (`DeltaPage` / `ScanPage`) echo `generation` so a mismatch is caught
mid-session without an extra round-trip. Each sync cycle compares the server's
`generation` to the stored one:

- **equal** → normal push/pull.
- **stored undefined** — split by the cursors, since undefined ≠ fresh:
  - **no cursors** (truly fresh replica) → bootstrap, then record the generation.
  - **has cursors** (a replica that synced before `generation` existed) →
    **migration, not reset**: adopt the server's generation and continue.
    Introducing `generation` must not client-reset every existing device.
- **stored ≠ server** (both defined) → the server lineage changed → run the
  client-reset policy (below), then record the new generation.

### Push fencing (anti-clobber, pushed)

Every **mutating `/fs` request** carries the client's known generation
(`x-fs-generation`) — not just path-sync push. `createFsApi` also exposes
inode/xattr/rename/dirent/blob mutation routes, used by the CLI and `frieren-auth`
via `apiStorage` (the inode-level HTTP backend); fencing only path-sync would
leave those as an unfenced back door.

The check must be **atomic with the mutation**, not a standalone middleware
pre-check: a pre-check can pass at `N`, a reset can bump to `N+1` and truncate, and
the mutation can still commit into the new volume. Fold the generation compare into
the **same SQLite transaction** as the write (`applyJournaled` for path-sync; each
inode op's transaction otherwise) — read the generation row, abort on mismatch. A
mount-level middleware may fast-reject cheaply, but correctness lives in the
transactional check.

The server rejects a stale write with `409 { error: 'generation_stale',
generation: <current> }`; the client treats it like a handshake mismatch (reset,
then retry). The reset routes themselves are exempt — they self-guard via the CAS.

### Reset endpoints

Auth-guarded DO routes, outside `createFsApi` (they need DO-level powers: truncate
the volume, bump the counter):

```
POST /fs/reset           { mode, fromGeneration: N, resetId? }   # mode: 'adopt-mine' | 'wipe'
  -> 200 { generation: N+1, resetId? }       # applied (publishing set for adopt-mine)
  -> 409 { error: 'generation_stale', generation: <current> }
  # resetId required for adopt-mine (owner of the publishing lock); optional for wipe

POST /fs/reset/finalize  { generation: N+1, resetId }   # adopt-mine only
  -> 200 { ok: true }                        # publishing cleared
  -> 409 { error: 'generation_stale' | 'not_owner' }
```

`fromGeneration` makes the bump a **compare-and-swap** — the DO applies only if
`N === current`, so racing resets can't interleave or double-bump. "Take theirs"
needs no endpoint (client-only). The DO must guarantee:

- **One atomic SQLite transaction.** The reset — CAS check, truncate the tree
  (`fs_inodes` / `fs_dirents` / `fs_xattrs`) and **both sync tables**
  (`fs_path_journal` and `fs_path_version`; the latter's `tombstone_version` would
  otherwise make a re-published put lose its LWW check), recreate the root inode,
  bump `generation`, store `resetId` — runs in one real SQLite transaction, so a
  crash leaves either the old lineage or the new one, never a mix. The generation
  is a SQLite row precisely so its bump commits with the truncate; a separate
  DO-KV counter couldn't share the transaction. This needs the DO adapter's
  `transaction()` to issue `BEGIN`/`COMMIT` (or use `ctx.storage.transactionSync`)
  — it is currently a no-op `await fn(adapter)`. `blockConcurrencyWhile` only
  serializes event delivery; it is not crash-atomic. `ensureBootstrapped` seeds
  the root inode once per DO lifetime and caches that it ran, so the reset must
  recreate root `ino=1` and invalidate that cache, or the wiped volume has no
  root. Content tables are mode-specific (see Wipe scope).
- **Quiesce the server's own writers.** Fencing `/fs` stops only HTTP mutations;
  the DO also writes `this.vol` directly (agent session, app capabilities,
  `ensureAgentDefaults`, daily-alarm maintenance), bypassing every `/fs` route. A
  reset/publish must pause or reject those for its window — quiesce the agent + app
  writes, or enforce the generation/`publishing` check in the storage mutators —
  or a mid-turn write races the truncate.
- **`resetId` disambiguates racing resets.** The client mints a random `resetId`,
  persists it before the CAS, and sends it; the DO stores the winner and echoes it
  in the handshake. Two devices that both target `N+1` are told apart by their
  distinct `resetId`s.
- **`adopt-mine` sets a `publishing` lock** owned by the winning `resetId`. While
  held, the DO rejects any mutation whose `x-fs-reset-id` ≠ owner (so only the
  initiator's publish writes land), and pull endpoints return not-ready so other
  devices defer their client-reset and don't consume a partial tree. `wipe` sets
  no lock (its initiator discards + re-bootstraps rather than publishing), so
  `resetId` is optional there.
- **Finalize is an explicit CAS that GCs before unlocking.** The initiator calls
  `/fs/reset/finalize` once the publish is durable; the DO clears `publishing`
  only if `generation === current` and `resetId === owner` (idempotent — a retried
  finalize is a no-op, a non-owner can't clear it). Because `adopt-mine` kept the
  old content rows for lazy blobs, finalize runs `gcUnreferenced()` first — the new
  tree now references the live hashes, so GC drops exactly the discarded old
  content (`fs_contents` + `fs_content_fts` + orphaned R2) — then clears the lock,
  so no stale hash can fetch discarded content once reads reopen.

### Interface changes (the minimal seam)

Today `SyncReplica` has no generation notion and `remoteSyncReplica()` takes only
`clientId`. Three additions:

- **Read the generation** — add it to the pull payloads (`DeltaPage` / `ScanPage`)
  and the `GET /fs` handshake; one new field on the `ChangeSource` return types.
- **Stamp it on writes, on both client paths** — the path-sync
  `remoteSyncReplica()` and `apiStorage()` (the inode backend the CLI/scripts use).
  Give both a generation source that sets `x-fs-generation` (`apiStorage` already
  threads a per-request header via `withSource`) and surfaces the
  `generation_stale` 409. During an `adopt-mine` publish the initiator also stamps
  `x-fs-reset-id`.
- **Persist it** in `/.state/sync` (`generation` + the `pendingReset` intent).

No other new RPCs beyond the two reset routes.

### Client-reset policy

Start **discard-only** ("take theirs"): on a mismatch, drop the local replica +
cursors and re-bootstrap against the current generation (Atlas's
`DiscardUnsyncedChanges`). `RecoverUnsyncedChanges` (re-apply this device's
local-only edits onto the new baseline) is the hard, CRDT-ish path — deferred;
ship discard + a clear warning first.

## The three operations

Let the current server generation be `N`.

**Reset local ("take theirs")** — no bump. The client discards its local replica +
cursors and re-bootstraps against `N`. Purely client-side; the common, safe case.
(For a local-only profile with no server, just wipe local IDB + reload.)

**Reset server ("take mine")** — mint a `resetId`, persist `pendingReset`, then
`POST /fs/reset { mode:'adopt-mine', fromGeneration:N, resetId }`. The DO truncates
the server tree + sync tables (keeping content blobs), bumps to `N+1`, and sets the
`publishing` lock. The initiator republishes its full local volume as the new
baseline (each write carrying `x-fs-reset-id`), then finalizes. It does not
re-bootstrap, so no local data is lost. Other devices see `N+1` and client-reset to
the new baseline; stragglers on `N` are fenced. (Git force-push, others
`reset --hard`, made safe.) Five things this must get right:

- **Republish is a full `pathScan()` snapshot, not a `pushCursor` replay.** Push
  filters `excludeLocalSource: REMOTE_SOURCE`, so every file this device *pulled*
  from the old server is tagged `REMOTE_SOURCE` and a cursor-replay would omit
  exactly the data we mean to preserve. Publish the coalesced local snapshot
  (`localReplica.pathScan()` → puts), then resume deltas from the frozen
  high-water.
- **Keep server content — do not delete `fs_contents` here.** With
  `lazyContent: true` the local replica often holds only a `contentHash` stub for
  files the user never opened; the bytes live on the server. `uploadBlobs` skips a
  hash the server already has and otherwise reads from the (empty) local store — so
  deleting server content the way `wipe` does would lose those bytes. Keep
  `fs_contents` intact so every referenced hash resolves (server-resident, or
  uploaded-from-local for locally-authored files); GC the now-unreferenced old
  blobs at finalize.
- **Preflight blob resolvability before the destructive CAS** (recommended). A
  cheap per-hash check (local `hasBlobByHash`, else server `HEAD /fs/blob/:hash`)
  fails *before* the reset, rather than stranding a half-published baseline if a
  hash is unexpectedly missing.
- **Don't expose a half-published baseline.** Between the bump and the last publish
  page the server holds `N+1` but only part of the volume. The `publishing` lock
  closes this: the handshake and pull endpoints report not-ready so others defer,
  and writes are owner-only so only the initiator publishes. (Debug phase: "close
  other devices first" is the interim mitigation.)
- **Crash recovery, keyed on `resetId` and `publishing`.** If the client crashes
  after the CAS but before the publish completes, the next boot sees `N ≠ N+1` and
  would otherwise discard-reset the data it meant to publish. Resume the publish
  only when `resetId` matches the server's current `resetId` **and** the server is
  still `publishing`. If it already finalized (`publishing=false`) the publish is
  done, so clear `pendingReset` and adopt `N+1` rather than republishing; if a
  different reset won (`resetId` mismatch), client-reset to the winner.

**Factory reset ("wipe both")** — `POST /fs/reset { mode:'wipe', fromGeneration:N
}`. The DO truncates the volume (including content tables — see Wipe scope) and
bumps to `N+1`. The initiator discards local + re-bootstraps into the now-empty
server; materialisation reseeds built-ins and pushes them as the `N+1` baseline.
Other devices reset to that baseline on their next handshake.

## Wipe scope

The entire volume — no carve-outs. Apps, agent soul/profile/sessions, and user
data are all files; sync treats the volume uniformly, so reset does too. Points to
be explicit about:

- **Blobs & content tables are mode-specific.** Both modes leave the R2 bytes
  orphaned (GC reclaims them; deleting inline is riskier with shared hashes).
  `wipe` also drops the `fs_contents` rows **and the `fs_content_fts` index** —
  `/fs/blob/:hash` serves straight from a `fs_contents` row and FTS5 retains
  extracted text, so keeping them would leave wiped content fetchable/searchable by
  any client that knows a hash, defeating a factory reset. The cost is that a
  re-push can't short-circuit on `hasBlobByHash` and re-uploads (R2 overwrites
  identical bytes). `adopt-mine` keeps both (lazy blobs) and GCs orphans at
  finalize instead. (To recover the upload-skip without the leak, we could gate
  `GET`/`HEAD /fs/blob` on a live inode reference; deferred.)
- **Server-seeded agent defaults reseed, so "empty" is short-lived.** The DO
  constructor runs `reset()` → `ensureAgentDefaults()`, seeding `/system/soul.md` +
  `/system/profiles/user.md` when absent. `POST /fs/reset` truncates in place and
  doesn't re-run the constructor, so the volume is momentarily empty, but the next
  DO restart reseeds those two files into the `N+1` baseline. Factory reset
  converges to *seeded defaults*, not a literally bare volume — the same
  server-vs-client seeding split `app-materialization.md` describes.
- **The `/.state/materialised` app-seed marker is mode-sensitive.** `seedBuiltins`
  seeds built-in apps at most once per replica, gated by this local-only marker and
  only when the volume is empty of apps after bootstrap. A client-reset that wipes
  IDB deletes the marker, so:
  - **Factory reset** leaves it unset — the server is intentionally empty and we
    *want* the client to reseed built-ins and push them.
  - **Take-theirs / client-reset** sets it after bootstrap — adopt the server
    verbatim, or a server the user intentionally emptied of apps looks "new" and
    gets built-ins reseeded and pushed back.
- **Non-volume DO state** (the `AuditLog` in `ctx.storage`, in-memory rate-limit
  buckets) is out of scope — it never syncs, so a volume reset neither reads nor
  clears it.

## Rollout

- **Now:** debug-gated (a dev-only shell affordance) to reproduce/repair forked or
  wedged replicas during development.
- **Later:** prod behind heavy confirmation — typed-to-confirm, a "this deletes
  everything on all your devices" warning for take-mine / factory reset, and a
  "close other devices first" note.

## Where the UI lives

Shell-level, not the sandboxed Settings app (`app.frieren.settings`), which can't
reach IDB, the sync lifecycle, or `location.reload()`. A small shell panel (like
`PersonalizePanel`), launched from the desktop context menu. "Take theirs" / "take
mine" are gated to **synced** profiles; a local-only profile only offers
factory-reset-local.

## Non-goals / open questions

- **Recover mode** (merge local-only edits onto the new baseline) — deferred; see
  Client-reset policy.
- **Generation granularity** — one per account/DO. Per-subtree generations are
  overkill and not planned.
- **Concurrent resets** — resolved by the `fromGeneration` CAS and the per-reset
  `resetId`: the loser is told it's stale and its `pendingReset.resetId` won't
  match, so it resets to the winner's baseline (and can retry from there).
- **Partial failure** — the reset is one atomic SQLite transaction, so it can't
  tear (once `transaction()` is real); devices converge idempotently. The
  `publishing` lock covers the one remaining multi-step case (adopt-mine's publish
  after the bump).
- **Stuck `publishing` lock** — if an adopt-mine owner dies after the CAS and never
  finalizes, others defer forever. Needs a liveness escape: a lease/timestamp so a
  stale lock expires or can be superseded by a newer `resetId`, plus a debug/admin
  cancel route. Manual cancel for the debug phase; a lease before prod.

## Suggested build order

1. **`generation` in the handshake + `/.state/sync`; client-reset-on-mismatch
   (discard-only), including the migration case (has-cursors-no-generation →
   adopt).** Cheap, and it hardens the normal path against a server
   restore-from-backup — worth doing even before the buttons.
2. **Push fencing** — `x-fs-generation` on every mutating `/fs` route (path-sync
   and the inode `apiStorage` client), enforced inside the mutation's SQLite
   transaction; `generation_stale` → reset; reset routes exempt.
3. **`POST /fs/reset` + `/fs/reset/finalize`** as one real SQLite transaction
   (`BEGIN`/`COMMIT` or `transactionSync`, not just `blockConcurrencyWhile`): CAS +
   truncate tree + `fs_path_journal` + `fs_path_version` + recreate root inode +
   bump + store `resetId`. Content is mode-specific — `wipe` also drops
   `fs_contents` + `fs_content_fts`; `adopt-mine` keeps them and runs
   `gcUnreferenced()` at finalize. Quiesce the DO's own `this.vol` writers for the
   window; adopt-mine adds the `publishing` lock (owner-only `x-fs-reset-id`
   writes, pulls gated). Wire "take theirs" (client-only) too.
4. **Shell UI** — debug-gated panel + confirmations.

Not touched: the path-sync wire beyond the additive `generation` field; per-file
identity is `path-based-sync.md`'s job. This doc is the volume-level lineage
identity on top of it.
