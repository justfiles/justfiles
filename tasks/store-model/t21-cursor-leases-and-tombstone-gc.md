---
project: packages/fs
status: todo
---

# T21: expire feed cursors and sweep tombstones

## Context

The change feed compacts every node id to its latest row, but a tombstone is that
latest row. It therefore stays forever. Normal deletes and T20 recovery both grow the
authority's tombstone set without bound.

Keeping tombstones forever is safe but not scalable. Deleting one too early lets a
long-offline peer replay the old live row and resurrect the deleted id.

The authority does not track replicas, and must not gain a replica registry. The model
remains peer-shaped: each receiver owns one feed and decides whether a caller may resume
that feed incrementally.

Current cursors are insufficient:

- the host saves both cursors locally;
- only `since(cursor)` sends a receiver cursor back to its issuer;
- `commit()` carries no receiver cursor, so the engine can push before the receiver can
  detect staleness;
- a cursor proves its store lineage and position, but has no authenticated expiry;
- there is no retained-feed floor, so no position says "history before here was swept".

The product policy is:

> A peer may push incrementally only while it holds a receiver-issued feed cursor still
> inside that receiver's retention window. An older peer preserves unacknowledged local
> work, bootstraps into a fresh store, then resumes from current authority state.

Default retention is 30 days. It is receiver policy, not a replicated setting.

Read [the store-model overview](README.md), [the minimal model](../../kb/fs/fable-design.md),
[engine core](../../packages/fs/engine.ts), and [the HTTP seam](../../packages/fs/http.ts)
first.

## Goal

Add one small protocol above `Store`, like the existing reset protocol:

1. A receiver signs its feed cursors and gives them an expiry.
2. Sync validates the saved receiver cursor before transferring blobs or pushing rows.
3. Every push carries a short-lived lease derived from that validated cursor.
4. A receiver rejects missing, forged, expired, wrong-lineage, or swept-behind leases
   before changing rows or blobs.
5. A stale peer bootstraps into a fresh local store; it never merges a snapshot into its
   stale table.
6. A bounded sweep atomically advances a global feed floor and removes old tombstones.

No receiver stores a row per replica. State is constant-size apart from retained rows:
one signing secret, one lineage, one feed floor, and bounded time checkpoints.

## Non-goals

- A replica registry, per-device acknowledgement table, or online-presence service.
- Proving that a malicious authorised client applied pages it requested. The lease
  prevents stale automatic writers; account owners already have write authority.
- Three-way merging offline edits. Stale work is preserved privately before bootstrap;
  later policy may offer it as new ids.
- Pruning live rows, recovery-store contents, or user-visible history.
- Using client `mtimeNs` to decide retention. Only receiver time is trusted.
- Making T20 depend on this task. T20 may safely retain canonical tombstones before this
  lands; T21 makes their storage bounded.

## Terms

- **Leased cursor** — opaque, receiver-signed feed cursor containing lineage, position,
  issue time, expiry, and mode.
- **Write lease** — short-lived signed capability minted from a valid resumable cursor.
  It is required on peer writes.
- **Feed floor** — lowest incremental position the receiver still supports. Positions
  below it require bootstrap even if their token has not expired.
- **Bootstrap cursor** — read-only cursor used to scan from empty after history was
  swept. It can read below the feed floor but cannot authorise a push.

## Leased cursor

`Cursor` stays an opaque string publicly. The receiver owns its encoded payload:

```ts
type CursorClaims = {
	lineage: string
	position: number
	issuedAt: number
	expiresAt: number
	mode: 'resume' | 'bootstrap'
}
```

The token is authenticated over every claim. Changing a position or expiry invalidates
the signature. Verification uses receiver time and checks:

```text
signature is valid
lineage is current
expiresAt > now
position is not beyond the feed head
resume position >= feed floor
```

An empty cursor starts a bootstrap. Bootstrap cursors may page through live rows whose
positions predate the floor. They are read-only. Reaching the current feed head mints a
normal resumable cursor.

Every successful caught-up `since()` call renews the resumable cursor, even when the page
is empty. A healthy quiet peer therefore keeps its lease without manufacturing rows.

The signing secret is receiver-private and persisted beside the store lineage. Replacing
the lineage rotates or invalidates it. No token or secret enters `Node`.

## Minimal peer protocol

Keep lease state above `Store`; do not add replica identity or expiry fields to the seam.
The HTTP host and an in-process P2P adapter expose the same three operations:

```text
open(saved receiver cursor) -> write lease | bootstrap-required
since(cursor)               -> page + renewed signed cursor
commit(lease, rows, guards)  -> accepted | bootstrap-required
```

`open` runs before blob probing or transfer. A stale client therefore cannot leave new
orphan blobs before learning it must bootstrap. `commit` verifies the lease again, so a
lease expiring or a floor advancing between `open` and `commit` still writes nothing.

The exact wrapper type is implementation detail. Required boundaries are:

- raw `Store` remains usable for local volume writes;
- peer-facing writes cannot bypass lease verification;
- the receiver, not the caller, verifies all token claims;
- direct P2P uses the same receiver wrapper as HTTP, without a central service.

## Normal incremental cycle

```text
client loads saved receiver cursor
        ↓
receiver validates signature, expiry, lineage, and floor
        ↓
receiver returns short-lived write lease
        ↓
client pushes its pending rows
        ↓
client drains receiver feed and saves renewed cursor
```

The current push-first rule remains for a valid lease. Validation happens before that
push; it does not apply remote rows over pending local work.

## Expired or swept-behind peer

`bootstrap-required` is a terminal answer for the current incremental cycle. The engine
must not erase the cursor and merge `since(undefined)` into the stale store: absence in a
snapshot cannot remove extra stale rows.

The host performs:

1. Stop incremental sync before any push.
2. Capture and verify unacknowledged locally authored work in the private recovery store.
3. Create a fresh empty local store with fresh local cursors.
4. Drain the receiver from an empty bootstrap cursor into that fresh store.
5. Finish at the feed head and obtain a resumable leased cursor.
6. Atomically switch the profile to the fresh store.
7. Keep recovered offline work private. Any later reintroduction uses new ids; it never
   silently resurrects a swept id.

A crash before the switch leaves the old profile active. A crash after the switch leaves
the fresh profile active. The host records the pending switch outside both databases.

## Tombstone retention and sweep

Receiver storage records commit time as backend-private metadata. User `mtimeNs` is never
used. The receiver also keeps a global `feedFloor`.

The feed head is a persisted high-water counter, not `MAX(seq)` over surviving rows.
Sweeping the newest stored tombstone must never let a later write reuse its sequence and
fall behind an already-issued cursor.

One bounded sweep transaction:

1. Select at most `SWEEP` tombstones committed before `now - retention`.
2. Calculate one position immediately after the highest selected tombstone.
3. Advance `feedFloor` to at least that position.
4. Physically delete the selected tombstone rows.
5. Commit the floor and deletes atomically.

Advancing the floor first without deleting is safe but unnecessarily fences cursors.
Deleting without advancing the floor is unsafe. They are one transaction or neither.

Live rows remain, including live rows below the floor. An empty bootstrap can still scan
them. Incremental cursors below the floor are refused because they may have missed a
deleted tombstone.

`gc()` stays bounded and reports whether more work remains. Blob sweeping remains a
separate reachability pass: removing a tombstone does not prove its old content hash is
unreferenced.

Replica row equality becomes equality modulo safely pruned tombstones. A peer may still
hold a tombstone another peer swept; normal incremental cursors have already passed it.
A future bootstrap may reintroduce a retained tombstone until both peers sweep it, which
is harmless and bounded by retention.

## Why no replica registry is needed

Safety comes from receiver state, not caller identity:

```text
valid cursor at/above floor -> incremental sync allowed
expired or below floor      -> bootstrap required
```

Each peer keeps the same constant-size receiver state. In a P2P pair, A validates tokens
it issued to B and B validates tokens it issued to A. Neither enumerates other peers.

Without a registry, cleanup waits the full retention window instead of pruning as soon as
all active replicas acknowledge a tombstone. That storage trade is deliberate.

## Failure semantics

- Forged, malformed, expired, wrong-lineage, and below-floor tokens all produce one
  public `bootstrap-required` result. Do not reveal signing details.
- Lease refusal changes no rows, blobs, cursor, or floor.
- Bootstrap preservation failure keeps the old local store active and surfaces sync
  error.
- Sweep failure commits neither row deletion nor floor advancement.
- Cursor validation and retention use a persisted, nondecreasing receiver observation of
  wall time. Clock rollback cannot extend a token.

## TDD plan

Tests describe behavior through peer, HTTP, sync, and host surfaces. Token codec and SQL
layout remain private. Use an injected receiver clock; do not sleep.

Implement one vertical red-green slice at a time:

1. **L01 — signed round trip.** A cursor returned by public `since()` resumes the same
   feed. Altering any byte produces `bootstrap-required`.
2. **L02 — lease before push.** A current cursor opens a lease and one public sync cycle
   pushes a row. Missing lease writes nothing.
3. **L03 — expiry.** Advance the injected clock past expiry. The same cycle is refused
   before blob transfer or commit.
4. **L04 — renewal.** A caught-up empty `since()` page renews the cursor; the renewed
   cursor remains usable after the old one expires.
5. **G01 — first sweep.** An old tombstone is removed while a live row and recent
   tombstone remain. `gc()` reports bounded progress.
6. **G02 — atomic floor.** A failure during sweep leaves both tombstone and floor as they
   were; retry removes it once.
7. **G03 — resurrection fence.** A cursor from before the swept tombstone cannot push its
   old live row. Authority state stays absent.
8. **G04 — monotonic head.** Sweep the tombstone at the feed tail, commit a new live row,
   and prove an already-issued cursor sees that row rather than skipping a reused seq.
9. **B01 — bootstrap is read-only.** Empty bootstrap pages can cross the floor, but their
   cursors cannot authorise a push.
10. **B02 — fresh-store replacement.** An expired Frieren profile preserves pending local
   work, builds a fresh IndexedDB replica, switches only after complete bootstrap, and
   does not retain an authority-absent stale row.
11. **P01 — symmetric peers.** Two in-process peers independently expire each other's
    cursors and recover by bootstrap without either storing a replica list.

After each GREEN, refactor only while the focused test and existing conformance tests are
green. Do not write all tests before implementation.

## Expected file map

- `packages/fs` — peer lease capability, bootstrap-required error, engine preflight;
- `packages/core` — signed HTTP cursor/lease handling and SQLite floor metadata;
- `packages/core/src/migrations` — receiver-private commit time, signing, and floor state;
- `platform/frieren/src/fs.ts` — fresh IndexedDB bootstrap and crash-safe profile switch;
- existing engine, HTTP, SQLite, synced, and Frieren tests — L01–L04, G01–G03, B01–B02,
  and P01.

Do not add replica ids, acknowledgement rows, token claims, or GC timestamps to `Node`.

## Acceptance criteria

- Authority storage contains no per-replica registry or acknowledgement row.
- Peer-facing push is impossible without a receiver-verified current lease.
- Signed cursor claims cannot be altered or extended by the caller.
- A healthy peer renews its cursor and keeps normal push-first behavior.
- An expired, foreign, or below-floor peer is rejected before blobs or rows change.
- Bootstrap uses a fresh local store and preserves unacknowledged work before switching.
- Old tombstones are removed in bounded transactions; recent tombstones and live rows
  remain.
- Tombstone deletion and feed-floor advancement are atomic.
- Feed sequence numbers never rewind or get reused after physical deletion.
- No valid incremental cursor can predate a swept tombstone.
- A year-old peer cannot resurrect a deleted id; it must bootstrap.
- Direct P2P and HTTP use the same receiver-owned lease rules.
- All existing store, cursor, sync, authority, HTTP, reset, and lifecycle tests pass.
