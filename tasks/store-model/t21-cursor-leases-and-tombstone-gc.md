---
project: packages/fs
status: done
---

# T21: expire feed cursors and sweep tombstones

## Context

The change feed keeps only each node's latest row. A tombstone is therefore the latest
row forever unless maintenance removes it. Keeping every tombstone is safe but grows
without bound; removing one too soon lets a long-offline peer push the old live row and
resurrect a deleted id.

The model remains peer-shaped and keeps the one `Store` seam. A local store and a remote
store expose the same operations. Peer transport adds a receiver-issued cursor token to
each call without changing `Store` or `Node`.

Read [the store-model overview](README.md), [the minimal model](../../kb/fs/fable-design.md),
[engine core](../../packages/fs/engine.ts), and [the HTTP seam](../../packages/fs/http.ts)
first.

## Decision

1. `Store` stays unchanged and remains both the storage seam and the wire shape.
2. A peer-facing `Cursor` is a receiver-signed token containing its feed position,
   lineage, mode, and expiry.
3. The remote `Store` adapter attaches the current receiver cursor to every operation.
   The receiver validates it before allowing the operation to affect its raw store.
4. There is no second storage-shaped `Peer` interface, `open` operation, or write lease.
5. Missing or stale relationship state starts a read-only bootstrap into a fresh store.
   It is never merged into the stale store.
6. Tombstone retention is a receiver-owned backend setting. Cursor lifetime is derived
   from that setting; sync never asks `Store` for a retention value.
7. When neither direction can resume, sync chooses one store with an injected function
   which returns the winning stable peer id. The current product always chooses remote.

## One retention setting

The backend owns one primary duration and one throughput knob:

```ts
const DEFAULT_HISTORY_POLICY = {
	tombstoneRetentionMs: days(30),
	deleteBatch: 128
} as const
```

`maxOfflineMs` is derived from `tombstoneRetentionMs`; it is not independently
configurable. A token is invalid when `expiresAt <= receiverNow`. A tombstone becomes
eligible only when its receiver commit time is strictly older than the retention
window. The strict boundaries mean a token which could have missed that tombstone is
invalid before deletion can occur. A later maintenance run only retains data longer.

The receiver persists a nondecreasing observation of its own wall clock. Client clocks
and user-controlled `mtimeNs` never decide expiry or retention.

## Cursor token

`Cursor` remains an opaque string. A receiver may encode:

```ts
type CursorClaims = {
	issuer: string
	lineage: string
	position: number
	expiresAt: number
	mode: 'resume' | 'bootstrap'
}
```

The receiver authenticates every claim. Verification checks:

```text
signature is valid
issuer and lineage are current
expiresAt > receiverNow
position is within the feed
resume position >= feed floor
```

`issuer` is the receiver's stable peer id. It survives a store-lineage reset and is the
identity used by a winner selector. Changing any claim invalidates the signature.

An empty cursor starts a bootstrap scan. Cursors returned before that scan reaches the
feed head remain `bootstrap` cursors and cannot authorize writes. The cursor becomes a
normal `resume` cursor only at the head.

Expiry is renewed only at the feed head, including a caught-up empty page. Intermediate
pages advance `position` but preserve the prior expiry. A caller cannot keep an old
view writable by repeatedly asking for only its first page.

## One `Store` seam

Raw local calls stay exactly as they are:

```ts
await store.commit(writes, guards)
await store.blobs.put(hash, bytes)
```

A relationship-bound remote adapter implements the same `Store` interface and adds the
cursor to its transport envelope:

```text
Store call
    -> operation + current receiver cursor
    -> receiver validates cursor
    -> receiver calls raw Store
```

HTTP carries the token in a private request header. An in-process P2P adapter passes the
same envelope directly. Neither transport adds a storage interface.

`storeApi(store)` remains the primitive HTTP projection of a `Store`.
`syncStoreApi(store, options)` composes the receiver and cursor header around that
primitive for a peer-facing endpoint. Hosts choose the protected form only where the
endpoint participates in sync.

Every peer-facing operation carries a token. Feed bootstrap is the sole tokenless entry:
`since(undefined)`. Read operations accept `bootstrap` cursors; row and blob writes
require `resume` cursors.

The adapter distinguishes two safe cursor sources without exposing them through
`Store`:

- peer writes use the last durably saved pull cursor;
- reads made while applying a page may use that page's newer in-memory cursor.

The second rule lets bootstrap fetch blobs before saving a cursor. It must never let an
unapplied page authorize a write.

## Write and GC ordering

The receiver validates a write immediately before its effect. Cursor validation and row
commit hold the same backing-store lock as tombstone deletion and destructive reset:

```text
commit first -> valid cursor, tombstone still exists, authority decides the write
GC first     -> feed floor advances and tombstone goes, old cursor is refused
reset first  -> lineage changes, old cursor is refused
```

This ordering removes the need for a short write lease or a post-fence grace period.
Blob bytes accepted before a later row refusal are harmless unreachable content and
remain the blob collector's work.

The feed head is a persisted high-water counter, not `MAX(position)` over surviving
rows. Deleting the last row must never let a later commit reuse its position and fall
behind an issued cursor.

## Bounded tombstone collection

`gc()` deletes at most `deleteBatch` eligible tombstones per call. In the same locked
transaction it advances `feedFloor` past exactly the rows it deletes. Live rows remain,
including live rows below the floor, so bootstrap can still rebuild current state.

Retention alone is enough for outbound safety because the engine pushes before it
pulls:

- a receiver cursor issued before a local tombstone expires no later than that
  tombstone becomes eligible;
- a cursor renewed after the tombstone implies the preceding push completed;
- if no current cursor exists, the next relationship is a fresh-store bootstrap and
  absence removes the stale live row.

No receiver stores a replica registry or per-peer acknowledgement rows. Different
stores may use different retention windows; their signed cursor expiries carry the
result of their own policy.

`gc()` keeps its existing result:

```ts
gc(): Promise<{ reclaimed: number; done: boolean }>
```

It returns `done: false` while another bounded batch is immediately eligible. Blob
collection stays a separate reachability pass.

## Private sync state

Relationship state is local data, not a replicated `Node`. It belongs in the existing
private mount:

```text
/private/state/clientid
/private/state/sync.json
```

The private mount is a separate store, so no ignore-list rule is needed. Do not revive
the legacy filtered `/.state` subtree in the shared store.

The full UUID in `clientid` is the stable peer identity. Sync reuses it as the version
author and winner id, while existing consumers may still use its short display form.
Keep the immutable identity file separate from frequently updated relationship state:

```ts
type SyncState = {
	remoteId?: string
	pull?: Cursor
	push?: Cursor
	discard?: boolean
}
```

Today each profile has one remote. A future multi-peer host may store one such record
per remote id without changing the sync engine or `Store`.

Cursor saves, clears, and bootstrap switches use the host's existing lock. The store's
receiver metadata remains backend-private: signing secret, lineage, feed head, feed
floor, observed time, commit times, and retention policy never enter `/private/state`.

## Expired or swept-behind relationship

Forged, malformed, expired, wrong-lineage, and below-floor tokens all yield the same
`bootstrap-required` result. Do not expose which check failed.

The winner selector is viewpoint-independent:

```ts
type ChooseWinner = (localId: string, remoteId: string) => string
```

Sync rejects a returned id which is neither participant. The current product defaults to:

```ts
const chooseRemote: ChooseWinner = (_localId, remoteId) => remoteId
```

A future equal P2P mode may choose the lower stable authenticated id. Both peers then
derive the same winner. An unauthenticated peer must not be allowed to choose an id
crafted to win.

When remote wins, the host:

1. Stops incremental sync before any peer write.
2. Retains the old local store as the recovery copy.
3. Creates a fresh empty local store and fresh cursors.
4. Drains remote through read-only bootstrap cursors.
5. Reaches the feed head and saves the first resumable cursor.
6. Atomically switches the profile to the fresh store.
7. Leaves recovered work outside sync; later policy may restore it under new ids.

The sync engine cannot replace storage it did not construct. It reports the winner and
the host owns this crash-safe replacement. A crash before the switch leaves the old
profile active; a crash after it leaves the new profile active.

The first release deliberately versions each host's local store and relationship-state
namespace. Existing unsigned cursors and stores are left untouched and signed-in users
start with a full remote bootstrap; there is no compatibility migration into the new
relationship.

## Non-goals

- A replica registry, per-device acknowledgement table, or presence service.
- Proving that an authorized caller applied every page it requested.
- Three-way merging stale offline edits.
- Replicating `/private/state` or any token metadata as `Node` rows.
- Adding retention, token, lock, or winner methods to `Store`.
- Using a peer cursor as account authentication.
- Pruning live rows, recovery stores, or user-visible history.
- Making blob promotion atomic with row commit.

## Failure semantics

- Invalid peer tokens change no rows.
- A blob accepted under a cursor may remain unreachable if the later row commit fails.
- Cursor validation, row commit, GC floor movement, deletion, and destructive reset use
  the same backing-store lock where their effects overlap.
- Bootstrap preservation failure keeps the old local store active.
- A failed GC transaction advances neither floor nor deletion.
- Clock rollback cannot extend a cursor.

## Proof tests

Use injected receiver clocks; never sleep.

1. **T01 — signed round trip.** A cursor returned by `since()` resumes the same feed;
   changing any claim causes bootstrap-required.
2. **T02 — operation token.** Every HTTP and in-process peer operation carries a cursor;
   a missing write token changes no blob or row.
3. **T03 — expiry.** A cursor works before its receiver expiry and fails at the boundary.
4. **T04 — head-only renewal.** Intermediate pages preserve expiry; a caught-up page
   renews it.
5. **T05 — bootstrap is read-only.** Empty bootstrap pages cross the floor but cannot
   authorize row or blob writes.
6. **T06 — no stale write race.** Race commit with GC and reset. Commit-first finishes
   before deletion/reset; GC/reset-first makes token validation fail.
7. **G01 — retention boundary.** A tombstone remains while any cursor which could have
   missed it may still be valid.
8. **G02 — bounded deletion.** Each GC call deletes at most `deleteBatch`, advances floor
   in the same transaction, and reports remaining immediate work.
9. **G03 — high-water feed.** Sweeping the newest row never permits position reuse.
10. **G04 — late and restarted GC.** Delayed maintenance and backend restart retain the
    same safety boundary.
11. **B01 — fresh-store replacement.** Expiry preserves pending local work privately,
    bootstraps into a fresh store, and does not retain an authority-absent stale row.
12. **S01 — one Store seam.** Sync, HTTP, and in-process P2P use `Store`; no second
    storage-shaped interface exists.
13. **S02 — private state.** Client id and relationship state survive shared-store
    replacement and never appear in its feed.
14. **S03 — winner.** The selected id must name one participant; remote-wins and a stable
    symmetric comparator choose the expected store.

## Acceptance criteria

- `Store` and `Node` have no token, retention, lock, or peer members.
- Raw local `Store` writes remain direct.
- Peer-facing writes cannot reach a raw store without a current receiver-issued cursor.
- Cursor expiry is renewed only at the feed head.
- Missing, expired, foreign, or swept-behind state bootstraps into a fresh store.
- The receiver validates writes at their effect and serializes them with destructive
  GC/reset operations.
- Tombstone retention and cursor lifetime come from one backend-owned policy.
- Tombstone deletion is bounded and feed positions are never reused.
- Relationship state lives in the private mount and reuses the stable client id.
- Winner selection returns and validates a participant id.
- HTTP and in-process P2P preserve the same `Store` seam and token rules.
- Existing store, sync, authority, migration, reset, and lifecycle tests pass.
