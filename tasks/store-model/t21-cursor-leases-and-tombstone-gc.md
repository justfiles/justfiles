---
project: packages/fs
status: done
---

# T21: expire feed cursors and sweep tombstones

## Receiver policy

Keep every timing and batch knob in one receiver-owned configuration. Do not scatter
duration literals through cursor, HTTP, database, or GC code:

```ts
const DEFAULT_SYNC_POLICY = {
	cursorLeaseMs: days(30),
	writeLeaseMs: minutes(15),
	maxWriteDurationMs: minutes(5),
	tombstoneFenceAgeMs: days(30),
	tombstoneGraceMs: days(10),
	deleteBatch: 128
} as const
```

Configuration validation requires:

```text
tombstoneFenceAge >= cursorLease
tombstoneGrace > writeLease + maxWriteDuration
```

A write lease also expires no later than its parent cursor. With defaults, a tombstone
is fenced after 30 days and physically retained for at least 10 more days. If cleanup
runs late, it remains longer than 40 days, never less.

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

Retention uses the centralized receiver policy above. It is not replicated state.

Read [the store-model overview](README.md), [the minimal model](../../kb/fs/fable-design.md),
[engine core](../../packages/fs/engine.ts), and [the HTTP seam](../../packages/fs/http.ts)
first.

## Goal

Add one small protocol above `Store`, like the existing reset protocol:

1. A receiver signs its feed cursors and gives them an expiry.
2. Sync validates the saved receiver cursor before transferring blobs or pushing rows.
3. Every push carries a short-lived lease derived from that validated cursor.
4. A receiver validates the lease on every blob write and again on row commit. Final
   validation and row commit are mutually excluded with a destructive lineage reset. A
   refused commit changes no rows; already accepted content-addressed blobs may remain
   unreachable until blob GC.
5. A stale peer bootstraps into a fresh local store; it never merges a snapshot into its
   stale table.
6. A bounded two-stage sweep first fences old tombstones, then removes them only after
   the configured grace period and durable outbound acknowledgement.

No receiver stores a row per replica. State is constant-size apart from retained rows:
one signing secret, one lineage, one feed floor, and one pending fence checkpoint.

## Non-goals

- A replica registry, per-device acknowledgement table, or online-presence service.
- Proving that a malicious authorised client applied pages it requested. The lease
  prevents stale automatic writers; account owners already have write authority.
- Three-way merging offline edits. Stale work is preserved privately before bootstrap;
  later policy may offer it as new ids.
- Pruning live rows, recovery-store contents, or user-visible history.
- Staging blobs or making blob promotion atomic with row commit. Unreachable blobs are
  safe and handled by the existing reachability GC boundary.
- Serializing every row commit with physical tombstone deletion. The retained grace
  barrier makes a pre-fence write lease expire before deletion becomes eligible.
- Creating a timer or extending `Store.gc()` with a per-fence wake-up timestamp. The
  existing daily maintenance cadence is sufficient; deleting later is safe.
- Adding a lock method to `Store`. Cursor ownership and cross-tab/process exclusion are
  host concerns, so the host supplies them privately when constructing a GC-capable backend.
- Making legacy `takeMine()` production-compatible with leased bootstrap. It remains a
  debugging/troubleshooting command and will not ship as a final product workflow.
  Leased hosts reject it as unsupported before any reset instead of adding a special
  adopt-mine protocol.
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
- **Outbound checkpoint** — the sender-local durable push cursor. It advances only after
  the peer accepts a page and proves which local feed positions no longer need to be
  retained as unacknowledged work.
- **Sync-state lock** — one host-private exclusive lock per immutable backing-store id.
  It serializes durable cursor changes with GC decisions made from those cursors, and
  leased row commits with destructive lineage resets.

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

A write lease expires at `min(now + writeLeaseMs, cursor.expiresAt)`. The receiver also
enforces `maxWriteDurationMs`, so no accepted operation can outlive the tombstone grace
window after the floor fences its cursor.

## Minimal peer protocol

Keep lease state above `Store`; do not add replica identity or expiry fields to the seam.
The HTTP host and an in-process P2P adapter expose the same leased operations:

```text
open(saved receiver cursor) -> write lease | bootstrap-required
put(lease, hash, bytes)      -> accepted | bootstrap-required
since(cursor)               -> page + renewed signed cursor
commit(lease, rows, guards)  -> accepted | bootstrap-required
```

`open` runs before blob probing or transfer. A stale client therefore cannot leave new
orphan blobs before learning it must bootstrap. Every blob `put` verifies the lease when
it accepts bytes; once the lease expires or falls behind the floor, later puts are
refused. `commit` verifies again, so expiry or floor advancement before commit writes no
rows.

The receiver holds the backing store's sync-state lock continuously across that final
lease validation and the row commit transaction. Any destructive reset holds the same
lock across emptying the store and rotating its lineage. The two possible orders are
therefore safe:

```text
commit first -> valid rows land -> reset removes them and rotates lineage
reset first  -> lineage rotates -> old lease fails final validation
```

`open` and blob puts need not hold this lock. If reset follows an accepted blob put, the
final row commit is refused and the unreachable blob follows ordinary blob GC. The lock
belongs to the receiver wrapper/reset host and does not extend `Store`.

Blob and row storage are deliberately not one transaction. Bytes accepted while the
lease was valid are not rolled back if a later `commit` is refused. They are unreachable
content-addressed blobs: no shared row points to them, and the ordinary blob
reachability sweep may reclaim them. This matches the existing rejected-push behavior
without adding a staging protocol to the core store.

The exact wrapper type is implementation detail. Required boundaries are:

- raw `Store` remains usable for local volume writes;
- peer-facing blob and row writes cannot bypass lease verification;
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
client transfers pending blobs through leased puts
        ↓
client commits its pending rows under the same lease
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

The legacy debugging-only `takeMine()` command is not this bootstrap path. Once leased
cursors are enabled, its host entry point returns unsupported before resetting anything.
It does not justify a production adopt-mine exception which can republish under a
replaced lineage.

## Tombstone retention and sweep

Receiver storage records commit time as backend-private metadata. User `mtimeNs` is never
used. The receiver also keeps a global `feedFloor`.

A store with an outbound role receives a read-only provider for its existing durable
push cursor when the GC-capable backend is constructed. This is private constructor
wiring, not a new `Store.gc()` parameter. A receiver-only authority has no provider. If
several configured outbound relationships must receive local work, the provider returns
all their durable cursors and the backend decodes its own opaque cursors to find the
minimum position. This state belongs to the sender; the receiver still keeps no replica
registry.

The same host supplies one exclusive sync-state lock keyed by the store's immutable
backing id. Every wrapper over the same database therefore shares the same lock. Browser
hosts use `navigator.locks` so tabs of the same origin exclude one another; a server's
single-owner serialization and an in-process P2P mutex provide the equivalent boundary.
The lock is private host wiring, not part of `Store`.

Every durable cursor save, including a clear or rewind during reset, runs under that
lock. A reset which replaces multiple cursor slots changes them in one critical section.
The push cursor advances only after `remote.commit(rows)` succeeds, and its save then
takes the lock. If any required cursor is empty, no local feed position is acknowledged
by every relationship, so no tombstone may be fenced. Non-empty cursors allow fencing
only positions strictly before their minimum. Pulled rows do not weaken safety: the push
scan advances over them, while every locally authored row in the same range is sent
before that cursor is saved.

The feed head is a persisted high-water counter, not `MAX(seq)` over surviving rows.
Sweeping the newest stored tombstone must never let a later write reuse its sequence and
fall behind an already-issued cursor.

Cleanup uses one persistent pending fence checkpoint:

```ts
type PendingFence = {
	through: number
	fencedAt: number
}
```

The bounded sweep has two stages.

**Fence:** when no checkpoint is pending, use one indexed boundary query to find the
highest feed position of any tombstone older than `tombstoneFenceAgeMs` and, for a store
with an outbound role, strictly before its durable push cursor. Hold the sync-state lock
across that cursor read and the transaction which advances `feedFloor` immediately past
the position and records `{ through, fencedAt: now }`. This fences the entire currently
eligible and acknowledged range without loading or deleting every row. Keep every
tombstone row.

**Delete:** only after `fencedAt + tombstoneGraceMs`, delete at most `deleteBatch`
tombstones at or below `through`. Hold the sync-state lock continuously while re-reading
every required durable push cursor and executing the deletion transaction. If a cursor
is empty or no longer past `through`, retain the checkpoint and rows until a later daily
check. Cursor saves and resets use the same lock, so none can land between this safety
check and deletion. Keep the checkpoint until no matching tombstones remain, then clear
it. A late first sweep still performs only the fence stage; it never treats age alone as
proof that the grace period happened.

The grace period applies once to the fenced range, not once per deletion batch. After
grace, repeated `gc()` calls drain all tombstones at or below `through` at normal bounded-batch
speed. Newer tombstones wait for the next fence generation after the checkpoint clears.
Reclamation capacity is therefore governed by deletion-call throughput, not
`deleteBatch / tombstoneGrace`.

This removes the validation/deletion timing race without coupling row commits to GC:

```text
tombstone exists
        ↓ fence: floor advances
old cursor cannot mint another write lease
        ↓ grace: existing write lease and request lifetime expire
tombstone still rejects any in-flight old live row
        ↓
physical deletion is safe
```

The fence transaction atomically stores the floor and checkpoint. The later delete is
safe only for positions at or below that persisted checkpoint and still acknowledged by
every outbound cursor under the shared lock. If reset wins the lock first, GC observes
the empty or rewound cursor and retains the tombstone. If GC wins first, deletion commits
before reset changes the cursor; that later reset must bootstrap from current state and
cannot reuse the previous incremental acknowledgement. A crash or cursor rewind can
delay cleanup but cannot skip either barrier.

Live rows remain, including live rows below the floor. An empty bootstrap can still scan
them. Incremental cursors below the floor are refused because they may have missed a
deleted tombstone.

`gc()` keeps its existing `{ reclaimed, done }` result. While a checkpoint is waiting
for grace or for a rewound outbound cursor to pass `through` again, it returns
`{ reclaimed: 0, done: true }`: there is no immediate work, so the ordinary daily
maintenance run checks again. Once deletion is eligible, each bounded batch returns
`done: false` while more rows at or below the checkpoint remain; the existing one-minute
continuation drains them. Deletion may begin up to one daily cycle after eligibility,
which is safe because retention only becomes longer. No timer or new `Store` interface
is introduced.

Blob sweeping remains a separate reachability pass: removing a tombstone does not prove
its old content hash is unreferenced.

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
- A lease invalid at `open` changes no rows, blobs, cursor, or floor.
- A lease becoming invalid during transfer stops later blob puts and changes no rows at
  commit. Blobs accepted earlier while valid may remain unreachable until blob GC.
- A destructive reset and leased row commit are linearized by their shared sync-state
  lock. Reset-first refuses the old lease; commit-first writes before reset empties the
  store.
- Bootstrap preservation failure keeps the old local store active and surfaces sync
  error.
- Fence failure commits neither floor nor checkpoint. Delete failure retains the
  checkpoint and remaining tombstones for retry.
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
5. **L05 — mid-transfer expiry.** Accept one blob put under a valid lease, advance the
   clock past expiry, and prove the next put and row commit are refused. The first blob
   is unreachable and the blob reachability sweep can reclaim it.
6. **L06 — reset/commit exclusion.** Pause a leased commit after its final validation
   and race a destructive reset. Prove both use the same backing-store lock: commit-first
   finishes before reset empties it; reset-first rotates lineage before validation and
   the old lease writes no row.
7. **G01 — fence full range.** More than `deleteBatch` old tombstones produce one
   checkpoint beyond the highest eligible position while every tombstone remains
   physically present and live and recent rows stay unchanged.
8. **G02 — atomic fence.** A failure leaves both floor and checkpoint unchanged; retry
   creates both once.
9. **G03 — grace barrier.** Mint a write lease just before fencing. During grace, its old
   live row still meets the tombstone and cannot land; the lease and maximum request
   lifetime expire before deletion eligibility.
10. **G04 — delayed inclusive deletion.** After one grace period, repeated bounded calls
   remove all tombstones at or below the checkpoint, including the boundary row, then
   clear it; no extra grace is paid per batch.
11. **G05 — late first sweep.** Advance the clock beyond the nominal 40-day minimum
   before running GC for the first time. It fences but does not delete until ten actual
   grace days pass.
12. **G06 — daily grace check.** Before eligibility, `gc()` returns `done: true` and the
   daily routine does not start minute continuations. The first daily run after grace
   starts bounded deletion and returns `done: false` until the checkpoint drains.
13. **G07 — retain unpushed work.** A locally authored old tombstone after the durable
   push cursor is not fenced. After the peer accepts it and the cursor saves beyond it,
   the next daily run may fence it.
14. **G08 — outbound rewind.** Rewind the push cursor during grace to model peer reset.
   Deletion waits with `done: true` until the tombstone is pushed again and the durable
   cursor passes `through`.
15. **G09 — reset/delete exclusion.** Pause deletion after it reads an acknowledged
   cursor, then race a reset which clears that cursor. Prove both operations use the same
   backing-store lock: when reset wins, deletion observes the empty cursor and retains
   the row; when deletion wins, reset cannot save until the delete transaction commits.
16. **G10 — monotonic head.** Delete the tombstone at the feed tail, commit a new live
   row, and prove an already-issued cursor sees that row rather than skipping a reused
   seq.
17. **B01 — bootstrap is read-only.** Empty bootstrap pages can cross the floor, but their
   cursors cannot authorise a push.
18. **B02 — fresh-store replacement.** An expired Frieren profile preserves pending local
   work, builds a fresh IndexedDB replica, switches only after complete bootstrap, and
   does not retain an authority-absent stale row.
19. **P01 — symmetric peers.** Two in-process peers independently expire each other's
    cursors and recover by bootstrap without either storing a replica list.

After each GREEN, refactor only while the focused test and existing conformance tests are
green. Do not write all tests before implementation.

## Expected file map

- `packages/fs` — peer lease capability, bootstrap-required error, engine preflight;
- `packages/core` — signed HTTP cursor/lease handling and SQLite floor metadata;
- `packages/core/src/migrations` — receiver-private commit time, signing, and floor state;
- `platform/frieren/src/fs.ts` — injects the durable push-cursor provider and performs
  fresh IndexedDB bootstrap with a crash-safe profile switch and shared sync-state lock;
- existing engine, HTTP, SQLite, synced, and Frieren tests — L01–L06, G01–G10, B01–B02,
  and P01.

Do not add replica ids, acknowledgement rows, token claims, or GC timestamps to `Node`.

## Acceptance criteria

- Authority storage contains no per-replica registry or acknowledgement row.
- Peer-facing push is impossible without a receiver-verified current lease.
- Signed cursor claims cannot be altered or extended by the caller.
- A healthy peer renews its cursor and keeps normal push-first behavior.
- An expired, foreign, or below-floor peer is rejected at `open` before blobs or rows
  change.
- Every peer blob put validates its lease. Mid-transfer expiry may leave only blobs
  accepted while valid; no row references them and blob GC can reclaim them.
- Final lease validation and its row commit share the backing-store sync-state lock with
  destructive empty-and-rotate reset. Old-lineage rows cannot land after reset.
- Bootstrap uses a fresh local store and preserves unacknowledged work before switching.
- All retention and batch values come from one validated receiver policy object.
- One fence covers the full currently eligible tombstone range; only physical deletion
  is batch-limited, and all batches share one grace period.
- A sender never fences a tombstone at or after its durable outbound push cursor. An
  empty or rewound cursor retains the row until acknowledgement is durable again.
- Cursor saves, resets, GC acknowledgement reads, and the resulting deletion transaction
  share one host-private lock per immutable backing-store id. No cursor can rewind
  between the deletion safety check and its commit.
- Grace waiting returns `done: true` and relies on daily maintenance; eligible deletion
  alone uses `done: false` for immediate bounded continuations. No timer or GC deadline
  field is added.
- With defaults, a tombstone is fenced at 30 days and remains for at least ten actual
  grace days before bounded physical deletion; recent tombstones and live rows remain.
- Feed-floor advancement and its pending checkpoint are atomic. Deletion requires the
  persisted checkpoint to have completed its grace period and includes its `through`
  boundary row.
- Write leases never outlive their parent cursor, and configured grace exceeds the
  maximum write lease plus receiver write duration.
- A commit admitted immediately before fencing cannot overlap physical deletion; the
  tombstone remains authoritative throughout its bounded lifetime.
- Feed sequence numbers never rewind or get reused after physical deletion.
- No valid incremental cursor can predate a swept tombstone.
- A year-old peer cannot resurrect a deleted id; it must bootstrap.
- Direct P2P and HTTP use the same receiver-owned lease rules.
- All existing store, cursor, sync, authority, HTTP, reset, and lifecycle tests pass.
