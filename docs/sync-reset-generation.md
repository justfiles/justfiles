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

- A single **monotonic integer** persisted in the DO (a SQLite row or DO KV),
  initialised once (e.g. `1`) and **bumped only by a reset**. It identifies the
  server volume's *lineage*, not its content — a bump means "the volume you knew
  is gone; re-establish from scratch".
- The client persists the generation it last agreed with in `/.state/sync`:

  ```ts
  type SyncState = {
    schemaVersion: number
    generation?: number   // server lineage this replica is synced against
    pushCursor?: SyncCursor
    pullCursor?: SyncCursor
  }
  ```

### Handshake check (correctness, pulled)

- `GET /fs` returns `generation` alongside the existing fields; pull responses
  (`DeltaPage` / `ScanPage`) **echo it** so a mismatch is caught mid-session
  without an extra round-trip.
- Each sync cycle compares the server's `generation` to the stored one:
  - **equal** → normal push/pull.
  - **stored is undefined** (fresh replica) → bootstrap, then record the server's
    generation.
  - **stored ≠ server** → the server lineage changed under us → run the
    **client-reset policy** (below), then record the new generation.

### Push fencing (anti-clobber, pushed)

- Push (`POST /fs/path/changes`, and blob puts) carries the client's known
  generation (e.g. an `x-fs-generation` header).
- The server **rejects** a push whose generation ≠ current, with a distinct
  status (e.g. `409 { error: 'generation_stale', generation: <current> }`). The
  client treats that exactly like a handshake mismatch: reset, then retry.
- This is the fencing token: a device that missed the bump **cannot** write the
  old volume's data back over the new baseline.

### Reset endpoint (compare-and-swap)

One auth-guarded DO route (not inside `createFsApi` — it needs DO-level powers:
truncate the volume, bump the counter):

```
POST /fs/reset  { mode: 'adopt-mine' | 'wipe', fromGeneration: N }
  -> 200 { generation: N+1 }               # applied
  -> 409 { error: 'generation_stale', generation: <current> }   # CAS failed
```

`fromGeneration` makes the bump a **compare-and-swap**: the DO only truncates +
bumps if `N === current`, so two devices racing a reset can't interleave or
double-bump. "Take theirs" needs no endpoint (it's client-only).

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

- **Reset server ("take mine")** — `POST /fs/reset { mode:'adopt-mine',
  fromGeneration:N }`. The DO **truncates the whole server volume**, bumps to
  `N+1`, returns it. The initiator stores `N+1`, **resets its own `pushCursor`**
  to replay its full local journal, and pushes the local volume up as the new
  baseline (stamped `N+1`). It does **not** re-bootstrap, so no local data is
  lost. Every other device sees `N+1 ≠ N` on its next handshake → client-reset to
  the new baseline; any of them still on `N` that tries to push is fenced.
  (Git force-push + others `reset --hard`, made safe.)

- **Factory reset ("wipe both")** — `POST /fs/reset { mode:'wipe',
  fromGeneration:N }`. The DO truncates the volume and bumps to `N+1`. The
  initiator discards local + re-bootstraps into the now-empty server → local ends
  empty → Phase-2 materialisation reseeds built-ins and syncs them up as the
  `N+1` baseline. Other devices reset to the (initially empty, then seeded)
  baseline on their next handshake.

## Wipe scope

**The entire volume — a factory reset, no carve-outs.** Apps, agent
soul/profile/sessions, and user data are all just files in the volume; sync
treats the volume uniformly, so reset does too. Two consequences to be explicit
about:

- **Blobs (R2)** are content-addressed; on a server wipe we **truncate the tree +
  journal + generation counter and leave blobs orphaned** (GC later). Leaving
  them is safe and even helps — a re-push finds a hash already present and skips
  the upload. Deleting them is riskier (shared hashes) and unnecessary.
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
- **Concurrent resets** — resolved by the `fromGeneration` CAS; the loser is told
  it's stale and resets to the winner's baseline (it can retry the reset from
  there if the user still wants it).
- **Partial failure** — the bump is a single serial DO mutation; other devices
  converge idempotently on their own schedule (no cross-device transaction).

## Suggested build order

1. **`generation` in the handshake + `/.state/sync`; client-reset-on-mismatch
   (discard-only).** Cheap, and it also hardens the *normal* path against a server
   restore-from-backup — introduce it even before the buttons.
2. **Push fencing** (`x-fs-generation` + `generation_stale` rejection → reset).
3. **`POST /fs/reset` modes** (`adopt-mine`, `wipe`) with the `fromGeneration`
   CAS; wire "take theirs" (client-only) too.
4. **Shell UI** (debug-gated panel + confirmations).

Not touched: the path-sync wire itself beyond the additive `generation` field;
per-file identity is `path-based-sync.md`'s job. This doc is the volume-level
lineage identity that sits on top of it.
