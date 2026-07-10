# Sync reset & generations (server-coordinated volume reset)

Status: proposal / design. No code yet. Companion to
[`docs/path-based-sync.md`](./path-based-sync.md) (the sync engine) and
[`docs/app-materialization.md`](./app-materialization.md) (single-origin
materialisation). Those two make sync *identity* correct; **this doc adds a
server-coordinated way to deliberately throw a volume away and re-establish it**
— "take theirs", "take mine", and "factory reset" — without forking replicas or
racing other devices.

## TL;DR

The unit of sync is the **whole volume**. Everything durable lives in it as
files: apps under `/applications/*`, agent soul/profile/sessions under
`/system/*`, user data everywhere else. There is **no special treatment** — a
reset targets the entire volume.

We need three destructive actions, initially **debug-gated**, eventually
shippable behind heavy confirmation:

1. **Reset local ("take theirs")** — discard this device's local replica, re-pull
   the server's volume from scratch.
2. **Reset server ("take mine")** — discard the server's volume, republish this
   device's local as the new baseline; every *other* device re-pulls it.
3. **Factory reset ("wipe both")** — discard server *and* local; start empty
   (client re-materialises built-ins per `app-materialization.md`).

The naïve version of this (three buttons that stop sync, mutate a side, resume)
is **unsafe on more than one device**: there is no coordination point, so a
stale device silently re-pushes deleted data and clobbers the reset, and a
device pulling a wiped server can't tell "empty" from "not yet loaded".

**The fix, straight out of prior art: a monotonic `generation` (epoch) owned by
the server, surfaced in the sync handshake, and used as a fencing token on
push.** The server is the single organiser (for a Frieren account it is literally
a single Durable Object — a free serialization point). A reset **bumps the
generation**; every other device notices the mismatch on its next handshake and
performs a **client reset** (discard-local, re-bootstrap); a device still on the
old generation is **rejected on push** so it can't clobber the new baseline.

Crucially this is **pull/handshake-driven, not an out-of-band command queue**:
the client re-derives "I must reset" every sync until its stored generation
matches the server's. Idempotent, offline-safe, no per-device server outbox.

## Prior art

Every mature multi-device sync system converges on "instance/lineage identity +
resync-on-mismatch", and separates the *correctness* signal (pulled) from the
*promptness* signal (pushed).

- **Microsoft Graph delta query** — pull `deltaToken`; server returns
  `410 Gone` / `syncStateNotFound` ⇒ client **restarts a full sync**. Change
  *notifications* are an explicitly separate push channel. "Delta = pull for
  correctness; notifications = push for promptness."
- **CouchDB replication** — the peer **Server UUID** feeds the *Replication ID*;
  progress is saved as checkpoints. Recreate the DB (new UUID) or lose common
  ancestry ⇒ **Full Replication**. Instance identity + checkpoint.
- **Litestream** — a **generation** (random hex) names a contiguous
  snapshot+WAL lineage; **any break starts a new generation**. Two writers on one
  destination don't clobber because their generations differ. This is our
  `generation` almost verbatim.
- **Replicache / Zero** — a server-controlled **cookie** = "a global version of
  the backend state"; a **poke** = a contentless "pull now" hint;
  `ClientStateNotFound` ⇒ the client resets. Closest to Frieren's browser model
  (poke == our caps-socket `dirty` nudge).
- **MongoDB Atlas Device Sync** — first-class **"client reset"** when the server
  can't reconcile a client (backup restore, history truncation, schema change),
  with modes **DiscardUnsyncedChanges / RecoverUnsyncedChanges /
  RecoverOrDiscard / Manual** — precisely the take-theirs / merge / take-mine
  menu.
- **Kafka** — `OffsetOutOfRange` ⇒ offset reset; **leader-epoch fencing** stops
  stale actors after truncation.
- **Fencing tokens** (Chubby / ZooKeeper; Kleppmann, *DDIA*) — a monotonic token
  the resource checks so **stale holders are rejected**. This is the anti-clobber
  primitive.
- **Dropbox / Git** — `list_folder/continue` can return `reset: true`; git
  rejects non-fast-forward, `--force` rewrites and everyone else `reset --hard`.
  "Take mine = force-push; others reset."

In-repo precedent: `path-based-sync.md` keeps a `negotiate()` handshake seam
(`GET /fs`) "for when a schema/protocol bump needs a probe", and notes the
*removed* legacy `FsCursorExpiredError` ("re-introduce an equivalent only if the
cursor can be pruned"). A `generation` is the cleaner, volume-level form of that
same "your cursor is invalid — resync" signal.

## Why pull/handshake beats a command queue

The tempting alternative — the server keeps a per-device "you must wipe" outbox
that clients drain — is worse on every axis:

- **Idempotent & self-healing.** With a generation the client re-derives the
  reset decision on *every* handshake until it matches. No acks, ordering, dedup,
  or redelivery.
- **Offline-safe.** A device dark for a month just learns on reconnect. A queue
  needs TTLs, expiry, replay.
- **No per-device server state.** The server keeps *one number*, not an outbox
  per device.
- **Fencing falls out for free.** The same generation that triggers a reset also
  rejects stale-generation pushes — killing the multi-device clobber race.
- A queue re-introduces exactly the multi-authority coordination mess the
  single-origin work (`app-materialization.md`, `ship-preview-incident.md`) is
  removing.

## Why this fits Frieren

- **The account's server is a single Durable Object.** DOs are single-threaded
  (`blockConcurrencyWhile`), so the generation is one counter mutated serially —
  **no distributed consensus needed**. Most prior art works hard for a
  coordination point we get for free.
- **The handshake exists.** `GET /fs` already returns
  `{ rootIno, protocolVersion, schemaVersion }` — add `generation`.
- **The seam exists.** `synced.ts`'s `negotiate()` is a placeholder whose comment
  says "add a handshake seam and branch here."
- **The poke exists.** The caps-socket `dirty` → `flushActiveVolume()` is
  Replicache's poke; it just makes the next pull prompt.
- **The state slot exists.** Cursors live in `/.state/sync` (local-only,
  `isLocalOnlyPath`). Add `generation` beside `pushCursor` / `pullCursor`.

## The model

### The generation

- A single **monotonic integer** persisted in the DO as a **SQLite row** (see the
  Reset endpoint for why not DO KV), initialised once (e.g. `1`) and **bumped only
  by a reset**. It identifies the server volume's *lineage*, not its content — a
  bump means "the volume you knew is gone; re-establish from scratch".
- The client persists the generation it last agreed with in `/.state/sync`:

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

- `GET /fs` returns `generation` (plus the current `resetId` and a `publishing`
  flag — see the reset endpoint) alongside the existing fields; pull responses
  (`DeltaPage` / `ScanPage`) **echo `generation`** so a mismatch is caught
  mid-session without an extra round-trip.
- Each sync cycle compares the server's `generation` to the stored one:
  - **equal** → normal push/pull.
  - **stored is undefined** → *split by the cursors, because undefined ≠ fresh*:
    - **no cursors** (truly fresh replica) → bootstrap, then record the server's
      generation.
    - **has cursors** (a replica that already synced before `generation`
      existed) → **migration, not reset**: it is already in step with the current
      server lineage, so just **adopt the server's generation** and continue
      normal push/pull. Do NOT discard — the code upgrade that introduces
      `generation` must not trigger a client-reset on every existing device.
  - **stored ≠ server** (both defined, differ) → the server lineage changed under
    us → run the **client-reset policy** (below), then record the new generation.

### Push fencing (anti-clobber, pushed)

- **Every mutating `/fs` request** carries the client's known generation (e.g. an
  `x-fs-generation` header) — not just path-sync push. `createFsApi` still
  exposes inode/xattr/rename/dirent/blob mutation routes, and real consumers use
  them: the CLI and the `frieren-auth` script build a volume over `apiStorage`,
  the inode-level HTTP backend. Fencing only `POST /fs/path/changes` + blob puts
  would leave those routes as an unfenced back door — a stale writer could clobber
  the new baseline through them after a reset.
- Implement the check as **one guard at the `/fs` mount** (a middleware over the
  `POST`/`PUT`/`PATCH`/`DELETE` methods) rather than per-route plumbing: the DO
  owns the generation, so the mount is the single natural place to compare it.
- The check must be **atomic with the mutation, not a standalone pre-check.** A
  middleware that reads the generation and *then* hands off to the route handler
  is a TOCTOU hole: the request can pass at `N`, a reset can bump to `N+1` and
  truncate, and the mutation can then commit into the *new* volume. Fold the
  generation compare into the **same SQLite transaction** as the write (the
  `applyJournaled` transaction for path-sync; each inode op's transaction for the
  inode routes) — read the generation row, abort on mismatch. The mount-level
  middleware may still fast-reject cheaply, but correctness lives in the
  transactional check. (Equivalently: run mutation and reset under one serialized
  critical section.)
- The server **rejects** any mutating request whose generation ≠ current, with a
  distinct status (`409 { error: 'generation_stale', generation: <current> }`).
  The client treats that exactly like a handshake mismatch: reset, then retry.
- **Exempt the reset route itself** (`POST /fs/reset`) from this guard — it
  carries `fromGeneration` and self-guards via the CAS below. Fencing it too
  would deadlock a device that legitimately needs to bump the generation.
- This is the fencing token: a device that missed the bump **cannot** write the
  old volume's data back over the new baseline, through any route.

### Reset endpoint (compare-and-swap)

One auth-guarded DO route (not inside `createFsApi` — it needs DO-level powers:
truncate the volume, bump the counter):

```
POST /fs/reset           { mode, fromGeneration: N, resetId? }   # mode: 'adopt-mine' | 'wipe'
  -> 200 { generation: N+1, resetId? }       # applied (publishing set for adopt-mine)
  -> 409 { error: 'generation_stale', generation: <current> }   # CAS failed
  # resetId REQUIRED for adopt-mine (owner of the publishing lock); optional for
  # wipe (no lock, no publish phase)

POST /fs/reset/finalize  { generation: N+1, resetId }   # adopt-mine only: publish done
  -> 200 { ok: true }                        # publishing cleared
  -> 409 { error: 'generation_stale' | 'not_owner' }            # CAS failed
```

`fromGeneration` makes the bump a **compare-and-swap**: the DO only applies if
`N === current`, so two devices racing a reset can't interleave or double-bump.
"Take theirs" needs no endpoint (it's client-only). Properties the DO must
guarantee:

- **One atomic SQLite transaction.** The generation lives as a **SQLite row** (a
  small meta row), NOT DO KV, and the whole reset — CAS check, truncate the tree
  (`fs_inodes`/`fs_dirents`/`fs_xattrs`) + **both sync tables**
  (`fs_path_journal` AND `fs_path_version` — the latter holds the per-path version
  generator *and* `tombstone_version`, so a surviving tombstone would make a
  re-published put lose the LWW check), **recreate the root inode**, bump
  `generation`, store the new `resetId` — runs in a single real SQLite
  transaction. Splitting truncate (SQLite) from the bump (DO KV) lets a crash
  leave a half-reset volume; one transaction leaves either the old lineage or the
  new one, never a mix. **This atomicity does not exist yet** and needs real work
  on two axes, which are NOT the same thing:
  - *Crash-atomicity* requires a real SQLite transaction — the DO adapter's
    `transaction()` is currently a no-op (`apps/frieren/worker/db.do.ts` just does
    `await fn(adapter)`, no `BEGIN`/`COMMIT`), so it must issue `BEGIN`/`COMMIT` or
    use `ctx.storage.transactionSync`. `blockConcurrencyWhile` does **not** give
    this — it serializes event delivery but a crash mid-sequence still tears.
  - *Serialization* (ensuring no other mutation interleaves the reset) is a
    separate concern, handled by the same-transaction generation check (see Push
    fencing) and/or `blockConcurrencyWhile` — don't conflate it with crash-
    atomicity.
  Note `ensureBootstrapped` seeds the root inode only once per DO lifetime and
  caches that it ran, so the reset must recreate root `ino=1` itself (and
  invalidate that cache) — otherwise the wiped volume has no root.
- **Quiesce the server's own writers.** Fencing `/fs` only stops *HTTP* mutations;
  the DO also writes the volume directly through `this.vol` (the agent session,
  app capabilities, `ensureAgentDefaults`, the daily-alarm maintenance). Those
  bypass every `/fs` route, so a reset/publish must also **pause or reject them**
  for its window — abort/hold the agent session + app writes (the same quiesce the
  `/applications` watcher uses), or enforce the generation/`publishing` check down
  in the storage mutators so even a direct `this.vol` write is gated. Without this,
  a mid-turn agent write races the truncate or lands in the half-published
  baseline.
- **`resetId` disambiguates racing resets.** The client mints a random `resetId`,
  persists it (`pendingReset`) *before* the CAS, and sends it. The DO stores the
  winning `resetId` and echoes it in the handshake. Two devices that both guessed
  target `N+1` are told apart by their distinct `resetId`s — the loser's won't
  match, so it never resumes a publish over the winner (see below).
- **`adopt-mine` sets a `publishing` lock with an owner.** The bump also marks the
  volume `publishing` (owner = the winning `resetId`) so other devices don't
  bootstrap a half-published baseline (see "take mine" below). While
  `publishing=true` the DO **rejects every mutation whose `x-fs-reset-id` ≠ the
  owner** — `x-fs-generation` alone can't tell the owner apart from a device that
  already advanced to `N+1`, so the initiator's publish writes carry
  `x-fs-reset-id: <resetId>` and everyone else is blocked. **Pull is gated too**:
  `pathDeltas` / `pathScan` return not-ready (or echo `publishing`) while the lock
  is held, so a client that was mid-scan when publishing began doesn't consume the
  truncated/partial tree. **`wipe` sets no lock** (its initiator discards +
  re-bootstraps rather than publishing), so `resetId` is optional for `wipe` — the
  DO may mint one for handshake consistency, but the client keeps no
  `pendingReset` for it (there is nothing to preserve).
- **Finalize is its own CAS route.** The initiator calls `POST /fs/reset/finalize
  { generation:N+1, resetId }` once the snapshot publish is durable; the DO clears
  `publishing` only if `generation === current` and `resetId === owner`. No
  implicit "last page clears the lock" — an explicit, idempotent call so a retried
  finalize is a no-op and a non-owner can't clear it.

### Interface changes (the minimal seam)

`generation` needs three small additions — today `SyncReplica` has no
handshake/generation notion and `remoteSyncReplica()` only receives `clientId`:

- **Read the server generation.** Echo it on the pull payloads the remote already
  returns — add `generation` to `DeltaPage` / `ScanPage` (and the `GET /fs`
  handshake) — so `pathDeltas` / `pathScan` results carry it and a mismatch is
  caught mid-session without an extra round-trip. This is the one new field on the
  `ChangeSource` return types.
- **Stamp the generation on writes — on both client paths.** Every mutating call
  must carry the client's known generation, and that is *two* code paths, not one:
  the path-sync `remoteSyncReplica()` (push / blob-put), AND `apiStorage()` over
  `createFsClient()`, the inode-level HTTP backend the CLI and scripts use. Give
  both a generation source (e.g. `remoteSyncReplica(client, { clientId,
  generation })` and `apiStorage(client, { generation })`) that stamps
  `x-fs-generation` (`apiStorage` already threads a per-request header via
  `withSource`), and have both surface the `generation_stale` 409 up so the caller
  refetches the generation / resets. Fencing all `/fs` routes *without* plumbing
  the inode client would just 409 every CLI mutation. During an `adopt-mine`
  publish the initiator additionally stamps `x-fs-reset-id: <resetId>` on its
  writes (the owner credential the `publishing` lock checks).
- **Persist it** beside the cursors in `/.state/sync` (`generation`, plus the
  `pendingReset` intent from take-mine).

Keep the surface minimal: a `generation` field on the pull payloads + a
generation getter on the remote replica + the two reset routes (`POST /fs/reset`,
`POST /fs/reset/finalize`) — no other new RPCs.

### Client-reset policy

Start with **discard-only** ("take theirs"): on a detected mismatch the client
drops its local replica + cursors and re-bootstraps against the current
generation (Atlas's `DiscardUnsyncedChanges`). This is the safe, simple default.

Deliberately **deferred**: `RecoverUnsyncedChanges` (re-apply this device's
local-only edits on top of the new baseline). That is the hard, CRDT-ish path;
we ship discard + a clear warning first, exactly as Atlas recommends.

## The three operations in terms of generation

Let the current server generation be `N`.

- **Reset local ("take theirs")** — *no bump.* Client discards its local replica
  + cursors and re-bootstraps against generation `N`. Purely client-side; the
  common, safe case. (For a local-only profile with no server, this is just "wipe
  local IDB + reload".)

- **Reset server ("take mine")** — mint a `resetId`, persist `pendingReset`, then
  `POST /fs/reset { mode:'adopt-mine', fromGeneration:N, resetId }`. The DO
  **truncates the server tree + sync tables** (keeping content blobs — see
  below), bumps to `N+1`, marks the volume
  `publishing` (owner = `resetId`), and returns. The initiator then **republishes
  its full local volume** as the new baseline (stamped `N+1`, each write carrying
  `x-fs-reset-id` so the lock lets it through), then calls `POST
  /fs/reset/finalize` to **clear `publishing`** and stores `N+1`. It does **not**
  re-bootstrap, so no local data is lost. Every other device sees `N+1 ≠ N` on its
  next handshake → client-reset to the new baseline; any of them still on `N` that
  tries to push is fenced. (Git force-push + others `reset --hard`, made safe.)

  Four things this must get right:

  - **Republish is a full `pathScan()` snapshot, NOT a `pushCursor` replay.**
    Normal push filters `excludeLocalSource: REMOTE_SOURCE` (`synced.ts`) — every
    file this device originally *pulled* from the old server is tagged
    `REMOTE_SOURCE` in its journal, so a cursor-replay would silently omit exactly
    the data we mean to preserve. Publish the coalesced local snapshot
    (`localReplica.pathScan()` → puts) instead; it reflects true local state
    regardless of who authored each file, then resume deltas from the frozen
    high-water (the same wind-forward bootstrap uses).
  - **Keep server content for adopt-mine — do NOT delete `fs_contents` here (lazy
    blobs).** Frieren syncs with `lazyContent: true`, so the local replica often
    holds only a `contentHash` stub for files the user never opened — the bytes
    live on the server. `uploadBlobs` skips a hash the server already has and
    otherwise reads it from the LOCAL store, which for a lazy stub is empty. If
    adopt-mine deleted server content the way `wipe` does, the initiator could
    neither skip nor upload those hashes and **the bytes would be lost**. So
    adopt-mine truncates only the tree + sync tables and **leaves `fs_contents`
    intact**: every hash the republished snapshot references stays resolvable
    (server-resident for pulled files, uploaded-from-local for locally-authored
    ones), and old now-unreferenced blobs are GC'd after finalize. (`wipe` is the
    opposite — it *must* drop content for privacy; see Wipe scope. A pre-CAS
    "hydrate every local blob" walk would also work but is a full download and
    unnecessary once we keep the content.)
  - **Don't expose a half-published baseline.** Between the bump and the last
    publish page the server holds the new generation but only *part* of the
    volume. Without a guard, another device sees `N+1`, bootstraps that partial
    (or empty) snapshot, and may materialise built-ins and push them — racing the
    initiator and corrupting the baseline. The `publishing` lock closes this on
    **both channels**: while it is set the handshake *and* the pull endpoints
    (`pathDeltas` / `pathScan`) report not-ready, so other devices **defer** their
    client-reset/bootstrap (and don't consume a partial tree mid-scan), while
    writes are owner-only (`x-fs-reset-id` must match) so only the initiator can
    publish. For the debug-gated phase the
    "close other devices first" note is the interim mitigation; the lock is
    required before prod.
  - **Crash recovery, keyed on `resetId` *and* `publishing`.** If the client
    crashes after the CAS (server at `N+1`) but before the republish completes,
    the next boot sees `stored(N) ≠ server(N+1)` and would otherwise discard-reset
    the very data it meant to publish. `pendingReset` overrides that — but the
    resume condition is **`resetId` matches the server's current `resetId` AND the
    server is still `publishing`**: only then resume the snapshot publish. If the
    server already **finalized** (`publishing=false`) the publish is done, so a
    stale `pendingReset` must **clear and adopt** `N+1` normally, not republish a
    second time. If a *different* reset won (`resetId` mismatch), clear it and
    client-reset to the winner. Using `resetId` rather than the number `N+1` is
    what stops a *losing* racer — who also persisted target `N+1` — from clobbering
    the winner. Clear `pendingReset` once the publish is finalized (or on adopt).

- **Factory reset ("wipe both")** — `POST /fs/reset { mode:'wipe',
  fromGeneration:N }`. The DO truncates the volume and bumps to `N+1`. The
  initiator discards local + re-bootstraps into the now-empty server → local ends
  empty → Phase-2 materialisation reseeds built-ins (and the server reseeds its
  `/system` agent defaults on its next restart — see Wipe scope) and syncs them
  up as the `N+1` baseline. Other devices reset to the (initially empty, then
  seeded) baseline on their next handshake.

## Wipe scope

**The entire volume — a factory reset, no carve-outs.** Apps, agent
soul/profile/sessions, and user data are all just files in the volume; sync
treats the volume uniformly, so reset does too. Consequences to be explicit
about:

- **Blobs (R2)** are content-addressed; on a server wipe we **truncate the tree +
  sync tables, bump the generation counter (never truncate it), and leave the R2
  bytes orphaned** (GC later). Deleting R2 bytes inline is riskier (shared hashes)
  and unnecessary — GC reclaims them.
  - **Delete the `fs_contents` rows on wipe (privacy wins over the upload-skip).**
    `/fs/blob/:hash` serves content straight from a `fs_contents` row (the row
    holds the hash → inline-bytes-or-`r2_key` mapping); if the wipe *keeps*
    orphaned rows, then wiped content is **still fetchable by hash** by any stale
    client that knows the hash — unacceptable for a factory reset whose whole point
    is to destroy the data. So the wipe drops `fs_contents` **and its FTS index
    `fs_content_fts`** — that FTS5 table retains extracted searchable text, so
    dropping content rows alone would leave the text queryable. The cost is that a
    later re-push can't short-circuit on `hasBlobByHash` and re-uploads (R2 just
    overwrites identical content-addressed bytes) — an acceptable trade. (If we
    ever want the upload-skip back without the leak, gate `GET`/`HEAD /fs/blob` on
    a *live inode reference* so orphaned content is non-readable while its row
    survives; deferred.)
  - So the wipe truncates the **tree** (`fs_inodes` / `fs_dirents` / `fs_xattrs`),
    **both sync tables** (`fs_path_journal` / `fs_path_version`), and
    **`fs_contents` + `fs_content_fts`**, then recreates the root inode (see Reset
    endpoint). (adopt-mine keeps `fs_contents`/`fs_content_fts` — see "take mine".)
- **Server-seeded agent defaults are reseeded, so "empty" is short-lived.**
  `Frieren`'s DO constructor runs `reset()` → `ensureAgentDefaults()`, which
  (idempotently) writes `/system/soul.md` + `/system/profiles/user.md` when
  absent. A `POST /fs/reset` truncates in place and does **not** re-run the
  constructor, so the server volume is momentarily empty; but the next DO restart
  reseeds those two files and they sync down as part of the `N+1` baseline. This
  is a deliberate exception to "no special treatment": the *wipe* is uniform, but
  the server owns a tiny built-in seed (the same server-vs-client seeding split
  `app-materialization.md` describes). Factory reset therefore converges to
  *seeded defaults*, not a literally bare volume — read the "starts empty" wording
  above with that caveat.
- **The `/.state/materialised` app-seed marker is mode-sensitive.** `seedBuiltins`
  seeds the built-in apps at most once per replica, gated by the local-only
  `/.state/materialised` marker (and only when `kernel.list()` is empty after
  bootstrap). A client-reset that wipes local IDB deletes that marker, so the
  modes must set it deliberately:
  - **Factory reset (wipe)** — leave the marker unset: the server is intentionally
    empty and we *want* the client to reseed built-ins and push them as the `N+1`
    baseline.
  - **Take-theirs / client-reset-on-mismatch** — **set the marker after
    bootstrap**, adopting the server verbatim. Otherwise a server the user
    intentionally emptied of apps looks "genuinely new" post-bootstrap and gets
    built-ins reseeded and pushed back — clobbering the user's intent. (The marker
    is per-replica and never synced; see `app-materialization.md`.)
- **Non-volume DO state** (the `AuditLog` in `ctx.storage`, in-memory rate-limit
  buckets) is **not part of the volume and is out of scope** — it never syncs, so
  a volume reset neither reads nor clears it. If we later want audit to reset too,
  that's a separate, explicit step.

## Rollout

- **Now:** debug-gated (a dev-only affordance in a shell panel). The point is to
  reproduce/repair forked or wedged replicas during development.
- **Later:** shippable to prod behind heavy confirmation (typed-to-confirm,
  explicit "this deletes everything on all your devices" warning for take-mine /
  factory reset, and a "close other devices first" note).

## Where the UI lives

Shell-level, **not** the sandboxed Settings app (`app.frieren.settings`) — that
app is capability-sandboxed and can't reach IDB, the sync lifecycle, or
`location.reload()`. Put it in a small shell panel (like `PersonalizePanel`),
launched from the desktop context menu next to "Personalize…" / "Switch User…".
"Take theirs" / "take mine" are gated to **synced** profiles; a local-only
profile only offers factory-reset-local.

## Non-goals / open questions

- **Recover mode** (merge local-only edits onto the new baseline) — deferred; see
  Client-reset policy.
- **Generation granularity** — one per account/DO (the sync unit). Per-subtree
  generations are overkill and not planned.
- **Concurrent resets** — resolved by the `fromGeneration` CAS *and* the per-reset
  `resetId`: the loser is told it's stale, and its `pendingReset.resetId` won't
  match the server's, so it never resumes a publish over the winner — it resets to
  the winner's baseline (and can retry the reset from there if the user still
  wants it).
- **Partial failure** — the reset (CAS + truncate + root inode + bump) is a single
  atomic SQLite transaction, so it can't tear (once the DO adapter's
  `transaction()` is made real — see Reset endpoint); other devices converge
  idempotently on their own schedule (no cross-device transaction). The
  `publishing` lock covers the one remaining multi-step case (adopt-mine's
  snapshot publish after the bump).
- **Stuck `publishing` lock** — if an adopt-mine owner dies after the CAS and
  never finalizes, other devices defer forever. Needs a liveness escape: stamp the
  lock with a lease/timestamp so a stale lock expires (or can be superseded by a
  newer `resetId`), plus a debug/admin cancel route. For the debug-gated phase a
  manual cancel suffices; a lease is required before prod.

## Suggested build order

1. **`generation` in the handshake + `/.state/sync`; client-reset-on-mismatch
   (discard-only), including the migration case (has-cursors-no-generation →
   adopt, don't reset).** Cheap, and it also hardens the *normal* path against a
   server restore-from-backup — introduce it even before the buttons.
2. **Push fencing** (`x-fs-generation` on every mutating `/fs` route — path-sync
   *and* the inode `apiStorage` client — enforced *inside the mutation's SQLite
   transaction*, not just a pre-check; `generation_stale` rejection → reset; reset
   route exempt).
3. **`POST /fs/reset` + `POST /fs/reset/finalize`** (`adopt-mine`, `wipe`) as one
   **real** SQLite transaction (`BEGIN`/`COMMIT` or `transactionSync`, NOT just
   `blockConcurrencyWhile`): CAS + truncate tree + `fs_path_journal` +
   `fs_path_version` + `fs_contents` + recreate root inode + bump generation +
   store `resetId`. Quiesce the DO's own `this.vol` writers (agent/apps/alarm) for
   the reset+publish window. adopt-mine adds the `publishing` lock (owner-only
   `x-fs-reset-id` writes, pulls gated, explicit finalize CAS); wire "take theirs"
   (client-only) too.
4. **Shell UI** (debug-gated panel + confirmations).

Not touched: the path-sync wire itself beyond the additive `generation` field;
per-file identity is `path-based-sync.md`'s job. This doc is the volume-level
lineage identity that sits on top of it.
