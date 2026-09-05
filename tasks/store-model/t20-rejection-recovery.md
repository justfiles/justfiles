---
project: packages/fs
status: done
---

# T20: recover rejected sync rows

## Policy

Keep `Store` and `Volume` unchanged. Sync and recovery use their existing primitives;
backends need no sync-specific tables, baseline/pending model, or checkpoint API.

Keep rename/revival repairs and edit/edit last-writer-wins. For other conflicts, the
authority wins: preserve displaced local data in private `Recovered items`, then
restore authority rows in place. Unknown conflicts follow this path as `unresolved`.
Recovered data never syncs. No merge engine or user prompt during sync.

Settle authority-absent ids with guarded tombstones. T21 bounds their retention and
safely collects them. Extra tombstones are acceptable; incorrect deletions are not.

Resume the existing cursors after recovery; no historical rollback or second shared
volume is needed. Only affected rows and required recovery bytes are copied. Invalid
cursors still use T21's fresh-store bootstrap; do not merge across expired history.

Authority rules allow children to arrive before their parent. An absent parent is
therefore different from an empty directory. Recovery must not strand authority data.
If safe settlement is impossible, preserve locally, leave shared rows unchanged, and
report the error.

References: [model](../../kb/fs/fable-design.md),
[conflict policy](../../kb/fs/sync-conflict-policy.md),
[cursor fencing and GC](t21-cursor-leases-and-tombstone-gc.md).

## Interface

Add `recovery?: Store` to `SyncOptions` and `SyncedProps`. Frieren passes
`entry.private`. Hosts without it retain semantic repairs; preservation fails safely.

The host supplies physically separate recovery storage and retains it across shared
store replacements. Frieren constructs a separate private database per profile.
Storage separation is the host's responsibility; object identity cannot prove it.
Missing or unreadable required recovery state blocks sync.

Keep `decide(facts)` pure and package-internal. `recover(input)` owns reads,
preservation, guards, and crash recovery; it returns `applied`, `raced`, or `failed`.
Unknown policy is not a failure; unavailable bytes or unsafe settlement is.
Examples below are pseudocode.

## Decision rules

Resume an interrupted settlement before applying policy. Otherwise, take the first
matching rule for the reported conflict:

| Test | Conflict | Decision |
|---|---|---|
| M01 | Live edit of a tombstoned id | Revive under a new id |
| M02 | Parent directory was deleted | Revive ancestors |
| M03 | Duplicate or taken sibling name | Rename |
| M04 | Invalid root | Preserve; restore authority root |
| M05 | Child below file, symlink, or mount | Preserve branch |
| M06 | Non-directory row would strand authority children | Preserve replacement |
| M07 | Parent cycle | Preserve moved branch |
| M08 | Other known structural conflict | Preserve affected graph |
| M09 | Unmatched kind | Preserve as `unresolved` |

Select every local row cleanup would displace. Include descendants when retiring a
branch; restoring the root alone does not displace its children. M09 selects all
authored rows in the rejected page and their descendants. Capture from the raw feed,
since visible tree walks can miss duplicates and cycles. Deduplicate by id,
retain captured versions, and enforce a total scan limit. Guard captured directories
as well as files; structural writers must bump affected parent versions. A changed
selection requires recapture before cleanup.

## Conflict facts

The refusal carries facts collected inside the authority's serialized commit path:

```ts
type Observation = { id: NodeId; row: Node | null }
type SyncConflict = {
	kind: string
	trigger: { id: NodeId; parent: NodeId; version: Version }
	authority: Observation[]
}
```

Include the trigger's prior row, its parent, and each row used to establish the
violation: name holder, stranded child, or cycle chain. Explicit `null` means absent;
omission means unknown. Choose violations in canonical `(id, version, kind)` order.
Encode embedded rows through the existing node wire codec. Malformed or unstructured
refusals are protocol errors; unknown structured kinds reach M09.

This snapshot explains the refusal. It does not cover the later local selection.
Read every selected id from the authority before planning cleanup; freeze those
observations for that attempt. These reads may span commits. They are not a second
coherent snapshot: null guards protect absent ids, and adoption receipts prevent
observed rows from being pushed back. Never infer absence from an omitted fact.

```ts
// Refusal names x; capture also finds descendant y.
const y = await remote.get('y')
// y === null: plan a guarded tombstone.
// y !== null: plan local adoption, never a write of y to remote.
```

## Preservation and settlement

For one captured selection:

1. Read authority rows. Mint each absent id's settlement tombstone once.
2. Copy source rows, metadata, and required bytes into a private operation. Record
   source versions, authority observations, planned tombstones, and graph rewrites.
3. Read back and verify every copied row and blob hash. Fetch lazy bytes from the
   authority when needed. Missing bytes, quota errors, or verification failure stop
   before shared writes.
4. Commit all planned tombstones to the authority in one batch, each guarded by
   `{ version: { id, is: null } }`. Apply the child check below in the same serialized
   path. A version race writes nothing and returns `raced`; unsafe settlement fails.
5. Durably record adoption receipts for every authority row and accepted tombstone
   that will replace a local row.
6. Install those exact rows locally in one commit, guarded by all captured source
   versions. A lost guard returns `raced`; success returns `applied`.

If there are no absent ids, step 4 writes nothing. Complete authority settlement
before any local cleanup. Once authority settlement succeeds, a later failure may
leave durable progress; retries resume it. Never claim cross-store atomicity.

Recovered rows form a valid forest under fresh private ids. External, missing, or
non-directory parents become operation roots; break cycles at the lowest source id;
number duplicate names in source-id order. Preserve original fields and edge/name
rewrites in the manifest. Keep user xattrs unchanged. Tombstone source records belong
in the manifest, not as invisible recovered files.

The owned recovery root has a fixed id and marker. A user-owned name gets a numbered
alternative; an occupied fixed id without the marker fails safely. Destination writes
use null guards for creation, reuse identical rows, and choose a new attempt for
changed rows. Never overwrite a user's recovered copy.

### Absent does not mean childless

```ts
const authority = { C: { parent: 'D' }, D: null }
const rejected = { id: 'D', type: 'file' }
await remote.commit([tombstone('D')], [absent('D')])
// Reject: C still needs D. The absence guard alone would pass.
```

For a tombstone submitted with an explicit null-version guard, the authority must
also reject any live child remaining under that id after the batch. Check this inside
the serialized commit path, not with a client-side preflight. Normal recursive-delete
commits retain their existing behavior.

Return `settlement-has-children`; the executor stops without invoking recovery again.
The private copy remains, and this attempt changes neither replicated store. Moving
or deleting authority children is outside T20. A later valid parent arrival may allow
recovery to continue by adopting that parent instead.

### Adoption must not become a local edit

```ts
const observed = await remote.get('x') // A:1
await remote.commit([editByB])        // B:2 arrives during preservation
await saveReceipt(observed)
await local.commit([observed], sourceGuards)
await sync(local, remote, opts)       // skip A:1; pull B:2
```

Persist an adoption receipt **before** installing an authority row. A receipt records
`(replica, remoteId, id, version)` in the profile's private recovery state, using the
existing peer identities. It marks this exact state as adopted, even if authored here.

Push requires both conditions, on every entry path including pull's nested drain:

```ts
const outgoing = authoredHere(row) && !await adopted(row.id, row.version)
```

Receipts survive restarts and cursor resets. New edits mint new versions and remain
outgoing. Never use an in-memory skip set, advance past unrelated pending rows, or
re-author the restored row. Pull eventually replaces a stale adopted row with the
current authority version.

Keep receipts with operation manifests, outside user-editable recovered files. Retain
them in T20; GC of shared tombstones does not remove them. Index exact lookups without
scanning every operation for every row. Hosts using preservation must retain this
private state across restarts; losing access blocks sync rather than disabling the
filter.

### Interrupted settlement

Find the planned tombstone by exact `(id, version)` in the verified operation, even
when the new refusal names a child of that id. Reverify the preserved copy before
cleanup; an old verification flag is insufficient if the copy was edited or deleted.

If source versions changed, recapture and preserve the current affected graph,
including new descendants, before adoption. Never revive a recorded settlement id.
A foreign tombstone with no matching operation still follows M01/M02. Receipt writes
and local adoption are idempotent; a crash between them safely resumes.

## Sync and bounds

Keep the current push → pull lifecycle, cursor locks, transport retries, and T21
bootstrap handling. Add receipt filtering and one `recover()` call after a structured
push refusal. Transfer source blobs before pushing as today; rejection may leave an
unreachable remote blob. Recovery uploads no private content.

Use distinct internal restart signals. Recovery restarts must not consume or reset
the existing ordinary replan budget:

```ts
if (error instanceof RecoveryReplan) continue
if (error instanceof Replan) {
	if (replans++ < REPLANS) continue
	throw error
}
```

Count every recovery call, including races, toward 4,096 attempts per `sync()`. Mark
its conflict fingerprint only after `applied`. A repeated applied fingerprint or an
exhausted budget fails immediately, without another recovery call. These terminal
errors bypass transport retries. Successful pages retain existing replan resets.

A conflict fingerprint canonically encodes kind, trigger, refusal authority
`(id, version | null)` pairs, and rejected `(id, version)` pairs. An operation key adds
decision and captured selection pairs. Sort inputs; exclude bytes. Persist minted
settlement versions on first creation and reuse them on retry. Neither key depends
on page order.

## Required tests

Use pure tests for M01–M09, real stores for recovery, and public `sync()`/`synced()` for
lifecycle behavior. Test rule precedence as well as individual branches.

| Area | Required behavior |
|---|---|
| Preservation | Exact rows, xattrs, bytes, root replacement, malformed forest, and unresolved fallback |
| Failure | Missing bytes, quota, verification, scan limit, and unavailable private state prevent unsafe cleanup |
| Ownership | Root collisions, concurrent creation, and edited/deleted recovered copies are safe |
| Crash | Reuse operation and minted versions; resume before/after receipts and local adoption |
| Local race | Recapture changed rows and newly added descendants before retirement |
| Authority race | An id appearing before settlement fails the null guard; never delete it |
| Detached child | Existing or racing child blocks absent-parent settlement atomically; ordinary recursive delete still works |
| Snapshot coverage | Selected descendants outside the refused page receive explicit authority reads |
| Adoption | A concurrent remote edit survives restore/retry, restart, cursor reset, and nested push; a fresh local edit still pushes |
| Settlement resume | Recognize own tombstones through child refusals; never revive them; foreign deletes retain repair policy |
| Bounds | 1,000 recoveries before page success; repeated fingerprints; 4,096 attempts including races; ordinary pull races remain bounded |
| Protocol | Structured conflict round-trip preserves bigint/xattrs; malformed refusal fails; unknown kind reaches M09 |
| Privacy | Host constructs separate private storage and retains it across shared-store replacement; no recovery uploads |
| Store seam | Recovery works through existing Store methods on memory and IndexedDB; no backend-specific recovery path |
| Incremental recovery | Ordinary refusals retain the shared store and cursors; settlement tombstones follow T21 GC; invalid cursors still require bootstrap |
| Existing behavior | Accepted pages, semantic repair without private storage, cursors, bootstrap, and lifecycle conformance |

Implement semantic recovery first, then preservation, receipts, settlement guards,
and crash/race cases. Keep tests behavioral; the table is the acceptance checklist.

Files: `packages/fs/{recovery,engine,authority,http,wire.internal,synced}.ts`,
`packages/core/src/store.api.ts`, `platform/frieren/src/fs.ts`, and their tests.
No Store/Volume signature changes or backend-specific recovery implementation.
