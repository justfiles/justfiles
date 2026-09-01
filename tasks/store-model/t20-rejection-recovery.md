---
project: packages/fs
status: todo
---

# T20: self-heal rejected sync pages

## Context

The authority owns the canonical shared namespace. It rejects a pushed page when the
resulting tree would violate a structural invariant: the root must remain a directory,
every live row needs a live directory parent, sibling names must be unique, a directory
with children cannot be retyped, and parent links cannot form a cycle.

Ordinary conflicts already have semantic repairs such as conflict rename, edit/delete
revival, and ancestor revival. A rejection without one of those settlements currently
leaves Frieren in `Sync error`, even when the server tree is healthy and only one local
branch is malformed.

The product policy is:

> The server wins the shared namespace. Local data is preserved before it is removed
> from that namespace.

Structural conflicts which displace local user data are preserved under
`Recovered items` in Frieren's private store. Any future or unclassifiable conflict
takes the same safe path and is marked `unresolved` for later user triage. Recovered
items never sync to the authority or to another device.

Read [the store-model overview](README.md),
[the minimal model](../../kb/fs/fable-design.md), and
[the conflict-policy research](../../kb/fs/sync-conflict-policy.md) first.

## Goal

Keep the interface small:

1. `sync()` drains change-feed pages, calls one recovery subroutine after a refused
   push, and retries when that subroutine made safe progress.
2. The recovery subroutine contains one pure, total decision machine. Every conflict
   produces `repair`, `preserve`, or the catch-all `unresolved` decision.

The state machine decides policy only. Store reads, copying, verification, guarded
writes, and retries are ordinary implementation details behind the recovery subroutine.
They are not machine states.

## Non-goals

- A state machine for the whole sync lifecycle.
- Exposing recovery-machine states, events, or commands publicly.
- Adding a base cache, content-aware merging, or changing edit/edit from
  last-writer-wins in this task. The recovery boundary remains open to that later work.
- Uploading recovered items, automatically deleting them, or asking the user to make a
  decision during sync.
- Hiding an operational failure which makes lossless preservation impossible.

## The whole lifecycle

There is no new `syncPage()` function. Sync already pages through each store's change
feed with `drain()`. A `Page` is a bounded batch of filesystem rows plus the cursor for
the next batch:

```ts
type Page = { nodes: Node[]; next?: Cursor }
```

A page is not a file and not the whole volume. Its nodes may describe files,
directories, symlinks, mounts, or tombstones. One `sync()` call drains every currently
pending local page to the authority, then every pending authority page into the local
store. Starting without a cursor visits the store's current feed from the beginning,
one page at a time, until it catches up. The current IndexedDB and filesystem stores
use 128 rows per page; the `Store` contract intentionally does not fix a page size.

The lifecycle keeps its existing `drain → push(rows) → commit` structure. Recovery is
one addition to the existing `GuardError` branch:

```ts
class Replan extends Error {
	constructor(readonly progress = false) {
		super('sync replanned')
	}
}

const push = async (rows: Node[]): Promise<void> => {
	await transfer(rows, local.blobs, remote.blobs)
	try {
		await remote.commit(rows)
		replans = 0
	} catch (error) {
		if (!(error instanceof GuardError)) throw error
		if (!isSyncConflict(error.reason)) throw error

		const recovery = await recover({
			conflict: error.reason,
			rows,
			local,
			remote,
			recovery: opts.recovery,
			replica: opts.replica,
		})
		if (recovery.kind === 'applied') {
			throw new Replan(true)
		}
		if (recovery.kind === 'raced') throw new Replan()

		throw recovery.error
	}
}

for (;;) {
	try {
		await drain(local, push, opts.push, mine)
		await drain(remote, pull, opts.pull)
		return
	} catch (error) {
		if (!(error instanceof Replan)) throw error

		// Replan is an async `continue` from push/recover to this outer loop.
		if (error.progress) replans = 0
		else if (replans++ >= REPLANS) throw error
		continue
	}
}
```

`Replan` is an internal control-flow exception, not a user-facing failure. A nested
page handler cannot directly `continue` the outer `sync()` loop, so it throws `Replan`
after guarded local progress or a guard race. The outer loop catches it and starts again
from current rows. Cursors lag committed work and row commits are idempotent, so there
is nothing to roll back. Its one `progress` bit distinguishes a completed recovery from
a no-progress guard race; it is not another recovery state.

For this task, `recover()` is called only after `remote.commit(rows)` returns a
structured authority conflict. An `applied` outcome guarantees safe local progress.
The push path translates it into `Replan(true)`, which resets the no-progress count. A
`raced` outcome uses the default `Replan()` and consumes the count. The existing limit
therefore guards repeated races or a bug without limiting a finite run of successful
recoveries.

The only app-visible outcomes remain:

- sync completes, including after automatic repair or private preservation; or
- sync fails because the recovery store or required bytes were unavailable, a guard
  kept racing, or another operational invariant prevented lossless recovery.

An unknown conflict is not an operational failure. It is the `unresolved` policy
decision and is preserved privately before sync continues.

## Recovery subroutine

Add one optional private store to the existing sync options:

```ts
type SyncOptions = {
	// existing properties
	recovery?: Store
}

type SyncedProps = {
	// existing properties
	recovery?: Store
}

type RecoveryOutcome =
	| { kind: 'applied'; decision: RecoveryDecision['kind'] }
	| { kind: 'raced' }
	| { kind: 'failed'; error: Error }

type RecoveryInput = {
	conflict: SyncConflict
	rows: Node[]
	local: Store
	remote: Store
	recovery?: Store
	replica: string
}

async function recover(input: RecoveryInput): Promise<RecoveryOutcome>
```

`RecoveryDecision` answers policy (`repair`, `preserve`, `unresolved`).
`RecoveryOutcome` answers execution (`applied`, `raced`, `failed`). An `unresolved`
decision which is copied and verified successfully produces the ordinary `applied`
outcome, not `failed`.

Frieren supplies the profile's private store. Keeping the option optional preserves the
package's current behavior for hosts which have no private store: semantic repairs still
work, while a decision requiring preservation returns `failed` without changing the
source. `sync()` rejects a recovery store which is the same `Store` object as `local`
or `remote`; otherwise a host mistake could put recovered data back into replication.

`recover()` does four things:

1. collect immutable facts from the authority conflict and the affected local graph;
2. call the pure decision machine once;
3. execute the returned decision with guarded store operations; and
4. return `applied` only after the decision is durable, `raced` after a lost guard, or
   `failed` when lossless recovery cannot finish.

## Pure recovery decision machine

The machine is deliberately smaller than the subroutine around it:

```ts
type RecoveryDecision =
	| {
		kind: 'repair'
		action: 'revive-row' | 'revive-ancestors' | 'rename' | 'restore-authority-root'
	}
	| { kind: 'preserve'; selection: RecoverySelection; reason: SyncConflict['kind'] }
	| { kind: 'unresolved'; selection: RecoverySelection; reason: 'unknown-conflict' }

function decideRecovery(facts: RecoveryFacts): RecoveryDecision
```

`RecoveryFacts` is a read-only package-internal record containing the structured
conflict, rejected rows, relevant local and authority rows, and a bounded
`RecoverySelection`. The selection contains captured `Node` values, their source
versions, and the selected graph roots. The executor receives the same facts beside
the returned decision, so the decision only needs to name policy and action; it does
not need to copy store data into a command object.

`decideRecovery()` is package-internal, synchronous, and pure. It receives plain data
and returns plain data. It does not receive a `Store`, clock, cursor, retry counter, or
callback. It cannot throw for an unknown conflict because its final rule is the total
catch-all.

The rules are ordered. The first match wins:

| Test | Match                                             | Decision                                         |
|------|---------------------------------------------------|--------------------------------------------------|
| M01  | dead row id with a live local edit                | `repair: revive-row`                             |
| M02  | missing parent which was an authority directory   | `repair: revive-ancestors`                       |
| M03  | duplicate or taken sibling name                   | `repair: rename`                                 |
| M04  | invalid local root                                | `repair: restore-authority-root`                 |
| M05  | child below a file, symlink, or mount             | `preserve` the rejected branch                   |
| M06  | directory retyped while authority children remain | `preserve` the local replacement                 |
| M07  | parent cycle                                      | `preserve` the locally moved branch              |
| M08  | any other known structural conflict               | `preserve` the affected local graph              |
| M09  | no earlier rule matched                           | `unresolved` with a conservative local selection |

The [compact decision graph](t20-rejection-recovery.html) is the visual companion to
this table. These nine edges are the entire state-machine test surface. Adding a future
policy means inserting one rule above M09 and adding its matching branch test; the
catch-all cannot accidentally disappear.

### Exact conflict facts

The authority returns a structured conflict created inside the same serialized
transaction which rejected the page. Independent HTTP reads cannot reconstruct that
snapshot coherently and are advisory only.

```ts
type SyncConflict = {
	kind: string
	trigger: { id: NodeId; parent: NodeId; version: Version }
	authority: Array<
		| { id: NodeId; version: null }
		| { id: NodeId; version: Version; row: Node }
	>
}
```

The refused `rows` are already in `RecoveryInput`, so the authority does not echo them.
The payload may be compressed without changing its semantics. `GuardError.reason` and
the HTTP 409 body gain this structured variant. An unknown structured `kind` reaches
M09; a malformed or legacy unstructured refusal is a protocol failure. Recovery never
parses an error string. When more than one row violates an invariant, authority
validation selects the trigger in canonical `(id, version)` order so the same rejected
transaction has a stable fingerprint.

### Future three-way merge

This task leaves edit/edit as last-writer-wins and adds no base cache, but it does not
close the recovery boundary around structural conflicts. A later sync engine may detect
that both sides changed from a saved base and call the same subroutine with richer
`RecoveryFacts`. A clean three-way merge becomes another `repair` action above M09.
An overlapping edit, missing base, or unsupported file type falls through to
`unresolved` and private preservation. A server-version guard race recollects facts and
tries the decision again against current data.

The future work needs a last-synced base and an authority-version guard; it does not
need a new lifecycle or a new top-level decision kind. `SyncConflict.kind` stays
extensible, `RecoveryFacts` remains package-internal, and `repair` may gain new actions.

### Conservative selection for `unresolved`

An unknown conflict still needs a bounded answer. The selection contains every
locally-authored row in the rejected page plus its local descendant closure from the
raw feed. This may preserve more data than strictly necessary, but it cannot silently
omit the rows the authority rejected. A scan limit, unavailable required blob, or
unavailable recovery store is an operational failure: the shared source remains
untouched and `sync()` reports an error.

This is the important boundary:

- **unknown policy** → `unresolved` → preserve privately → server wins → retry;
- **cannot preserve safely** → `failed` → keep source untouched → surface the error.

## Executing a decision

### `repair`

Apply the selected semantic repair with guards and return `applied`. A lost guard
returns `raced`; `sync()` rereads current rows and calls recovery again. It does not add more
states to the decision machine.

### `preserve` and `unresolved`

Both decisions use the same data-safe executor:

1. Capture the bounded affected local graph and its source versions.
2. Copy all available rows, metadata, and bytes to the private recovery store.
3. Attach the complete operation below the owned `Recovered items` root.
4. Read the recovered rows and hashes back through `Store` and verify them.
5. Only after verification, guard-clean the captured locally-authored shared rows.
6. Restore authority rows locally, or use a non-pushable local tombstone when the
   authority has no row.
7. Return `applied`.

The captured graph need not already be a valid tree. The executor deterministically
turns it into a valid recovered forest: a row with a missing, external, or
non-directory parent becomes an operation root; each cycle is broken at its lowest
node id; and duplicate sibling names are numbered in source-id order. Rewrites are
recorded only in the synthetic operation manifest, never by replacing user xattrs.
For a lazy stub, recovery fetches and verifies the required blob from the authority
before cleanup; if neither store can supply it, recovery returns `failed`.

The operation manifest records whether the decision was `preserve` or `unresolved`,
the structured conflict fingerprint, and any edge or name rewritten while producing a
valid recovered forest. Copied user xattrs remain byte-for-byte unchanged.

Terminal cleanup never sends a delete to the authority. Restoring peer-authored rows
or using local-only tombstones lets the next pull install current server state without
turning server-wins into an accidental server deletion.

Recovery itself never writes a row, manifest, path, or blob to the shared remote.
However, the existing push order transfers source blobs before `remote.commit(rows)`
so the peer cannot receive a row whose content is missing. A blob transferred before
the authority rejects that row may therefore remain as an unreachable content-addressed
blob. Avoiding that narrow pre-existing behavior requires a validate/reserve protocol
and is outside this task; no shared path points to the blob.

## Idempotence and concurrency

These constraints belong to the recovery executor, not to its decision machine:

- The private recovery root has a fixed id and ownership marker. A user-owned
  `Recovered items` name is left alone and the system chooses a numbered display name.
  If the fixed id already exists without the exact marker, recovery fails safely rather
  than adopting or overwriting it.
- An operation fingerprint includes the decision, trigger, relevant authority
  versions, and sorted source `(id, version)` pairs.
- Before every destination write: absent means null-guarded create, identical means
  reuse, and different means preserve the existing row and choose the next attempt.
- Source cleanup is guarded by captured versions. A concurrent local edit causes a
  fresh recovery call rather than losing the edit.
- Raw-feed capture is chunked and has a total row limit, so continuous writes cannot
  trap one call forever.
- Copy and verification always precede cleanup. A crash or quota failure leaves the
  shared source recoverable.

## TDD plan

Tests describe behavior through the smallest relevant interface. The nine decision
tests call the pure function. Recovery tests call `recover()` with real `memStore`
instances. Lifecycle tests call public `sync()` or `synced()`; they do not assert on
internal calls or states.

### Decision-machine tests

- **M01** — dead id selects row revival.
- **M02** — deleted directory parent selects ancestor revival.
- **M03** — duplicate name selects conflict rename.
- **M04** — invalid root selects authority-root restoration.
- **M05** — child below file, symlink, or mount selects private preservation.
- **M06** — directory retype with authority children selects private preservation.
- **M07** — cycle selects private preservation of the moved branch.
- **M08** — another known structural kind selects private preservation.
- **M09** — every unmatched kind returns `unresolved`; it never throws or returns
  `undefined`.

### Recovery-subroutine tests

- **R01** — a semantic decision commits its guarded repair and returns `applied`.
- **R02** — a known structural decision preserves the exact affected graph and user
  xattrs privately, keeps rewrite annotations in the manifest, applies server-wins
  locally, and returns `applied`.
- **R03** — an unknown conflict preserves the conservative graph as `unresolved`,
  applies server-wins locally, and returns `applied`.
- **R04** — verification failure occurs before cleanup and leaves every source row
  intact.
- **R05** — a required blob missing from both stores returns `failed` with the source
  intact.
- **R06** — retry after a crash reuses an identical recovery operation without showing
  a duplicate; a different canonical trigger produces a different operation.
- **R07** — a user-edited recovered row is never overwritten; a later attempt is used.
- **R08** — a user-owned root name and concurrent root creator cannot be adopted as the
  system root.
- **R09** — a concurrent local source edit returns `raced`; the next call recovers its
  new version.
- **R10** — an authority row arriving after refusal is never deleted by local cleanup.
- **R11** — a raw-feed capture which reaches its total row limit returns `failed`
  without cleanup, even while writes keep extending the feed.

### Sync-lifecycle tests

- **S01** — an accepted page completes without constructing recovery facts.
- **S02** — a known conflict is recovered, retried, and completes in the same `sync()`
  call.
- **S03** — an unknown conflict creates an `unresolved` private item, retries, and
  completes without asking the user.
- **S04** — more than the old replan count of independent productive recoveries still
  converges; only no-progress repetitions consume the guard.
- **S05** — an operational recovery failure leaves the source intact and becomes the
  app's sync error.
- **S06** — a malformed or legacy unstructured authority refusal stays a protocol
  error; the source remains intact.

### Host and privacy tests

- **H01** — Frieren passes `entry.private` as the recovery store.
- **H02** — the recovery executor never writes recovered rows, manifests, paths, or
  blobs to the shared remote.
- **H03** — a host without a recovery store can still apply semantic repairs, but a
  preservation decision fails safely without cleanup.
- **H04** — passing `local` or `remote` itself as the recovery store is rejected before
  sync changes any store.

### Vertical implementation order

Implement one behavior at a time:

1. M01 → R01 → S02 proves the smallest end-to-end semantic recovery.
2. M05 → R02 proves known structural preservation.
3. M09 → R03 → S03 proves the unresolved catch-all.
4. Add M02–M04 and M06–M08 one branch at a time.
5. Add R04–R11 one safety invariant at a time.
6. Finish S01, S04–S06 and H01–H04, then run existing conformance suites.

## Expected file map

- `packages/fs/recovery.ts` — `recover()` and package-private decision machine;
- `packages/fs/recovery.test.ts` — M01–M09 and R01–R11;
- `packages/fs/engine.ts` — the conflict branch which calls `recover()`;
- `packages/fs/engine.conflicts.test.ts` — S01–S06;
- `packages/fs/store.ts`, `authority.ts`, and `http.ts` — structured conflict payload;
- `packages/fs/synced.ts` — forwards the optional recovery store into `sync()`;
- `packages/fs/synced.test.ts` and Frieren lifecycle tests — H01–H04;
- `platform/frieren/src/fs.ts` — supplies `entry.private` from `startSync()`.

No public recovery-machine module, command interpreter, or lifecycle state hierarchy is
introduced.

## Acceptance criteria

- `sync()` has one recovery call in its conflict branch and otherwise keeps its current
  lifecycle.
- The pure decision function has exactly three outcome kinds: `repair`, `preserve`, and
  `unresolved`.
- Every known rule and the catch-all have a named unit test matching the visual graph.
- Unknown conflicts are preserved privately and do not ask the user for a decision.
- Cleanup runs only after private verification and never deletes authority data.
- Recovery never writes its private rows, manifests, paths, or blobs to the remote;
  pre-rejection orphan source blobs remain the existing push-order limitation.
- Operational preservation failures keep shared source rows intact and remain visible
  as sync errors.
- The internal facts and `repair` action can grow to support a future guarded
  three-way merge without changing `sync()` or the three top-level decision kinds.
- All existing store, sync, authority, HTTP, cursor, and lifecycle tests continue to
  pass.
