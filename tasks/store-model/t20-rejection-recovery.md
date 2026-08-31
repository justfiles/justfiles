---
project: packages/fs
status: todo
---

# T20: self-heal rejected sync pages

## Context

The authority is the arbiter of the shared namespace. It accepts a pushed page only
when the resulting tree satisfies rule 9: the root remains a directory, every live
row has a live directory parent, names are unique, directories are not retyped while
they still hold children, and parent links do not form a cycle.

`engine.ts` already resolves the ordinary conflicts for which the shared namespace
has an unambiguous answer:

- create/create keeps both files under conflict names;
- edit/delete recreates the edited file under a new id;
- deleting a directory while another replica writes below it revives the directory
  chain; and
- edit/edit is currently last-writer-wins.

An authority refusal which writes no settlement is different. Today `sync()` returns
the `GuardError`, `synced()` enters `error`, and Frieren cannot finish its initial
sync. A real example is a locally-authored file whose parent is a `mount`. The
authority must refuse it: a mount's children belong to its bound local store, and a
child in the shared store would cross the privacy boundary. The current test names
this an "unresolved refusal" and deliberately proves that retrying the unchanged page
cannot help.

The manual whole-profile resets are not an acceptable automatic repair. `takeTheirs`
would discard every unpushed local edit because one row is malformed; `takeMine`
would try to publish the malformed topology as the new authority baseline.

This task makes every current authority rejection reach one of two terminal states:

1. a semantic repair changes the local shared rows and the page is replanned; or
2. the smallest affected local graph is durably salvaged into a local-only recovery
   store, its invalid shared state is cleaned, and the page is replanned.

Only an unknown future refusal or failed salvage remains an error. The app then keeps
the current recovery menu as the explicit escape hatch.

Read [the store-model overview](README.md),
[the minimal model](../../kb/fs/fable-design.md), and
[the existing conflict-policy research](../../kb/fs/sync-conflict-policy.md) first.

## Product policy

> The server wins the canonical shared namespace. Locally unique content is never
> silently discarded.

Semantic conflict copies remain shared data and sync normally. Terminal recovery is
different: its inputs are structurally invalid and match a defined recovery plan.
Those items always land in a local-only store under `Recovered items`; no recovered
row or recovery path appears in the shared store or at the authority. A later explicit
restore may copy an item back into the shared namespace.

This distinction follows the useful split in the prior art:

- Dropbox, Syncthing, and OneDrive keep both valid concurrent edits under distinct
  names; and
- filesystem repair and Git put structurally unreachable objects in an orphanage or
  `lost+found` rather than guessing their intended canonical path.

The local-only default is load-bearing. A rejected subtree may be data that leaked
below a mount. Uploading it as `/Recovered items/...` would turn recovery into a
privacy breach and would replicate a device-local corruption to every healthy device.

The existing push path uploads content before committing its row, as rule 10 requires.
The engine therefore runs the same read-only tree inspection before blob transfer and
repairs any refusal it can already prove. This prevents the ordinary malformed-row
case from uploading its bytes. It is not an atomic reservation: a concurrent authority
write after inspection can still make the later commit fail after the bytes arrive,
leaving an unreachable content-addressed blob. Eliminating even that narrow race
requires a validate/reserve/finalise protocol and is outside this task. It does not
make the recovered tree visible or sync it to another device.

## Goals

- A recoverable authority rejection never leaves Frieren in `Sync error`.
- Repair touches only the rows implicated by the rejected invariant.
- Every locally available blob and all node metadata in the affected subtree survive.
- Recovery is safe across crashes, retries, concurrent local writes, pagination, and
  browser reloads.
- Recovered items stay local-only.
- Existing successful conflict outcomes and the `Store` seam do not change.
- Every behavior is exercisable with `memStore`, `authority`, `sync`, and `synced` in
  Vitest; no browser, database inspection, timer sleep, or internal-function mock is
  required.

## Non-goals

- Content-aware merging of arbitrary file bytes.
- A CouchDB-style replicated revision tree.
- Changing edit/edit from last-writer-wins; that remains the separate base-cache work
  in `sync-conflict-policy.md`.
- Uploading the private recovery store or showing it on another device.
- Automatically deleting recovered data.
- Recovering bytes which are absent from the local store and cannot be fetched from a
  peer. The row may be a legitimate lazy stub only when another store can still supply
  its hash.
- Replacing the existing manual `takeMine`, `takeTheirs`, and factory-reset actions.

## Fixed decisions

### One optional recovery store

Add one optional property to the existing sync options and thread it through the
lifecycle wrapper:

```ts
type SyncOptions = {
	// existing properties
	recovery?: Store
}

type SyncedProps = {
	// existing properties
	recovery?: Store
}
```

`recovery` is a local-only `Store` owned by the host. It is never wrapped in
`authority`, never passed as `remote`, and never included in a binding map unless the
host deliberately exposes it through its volume. Omitting it preserves today's
behavior: a semantic repair is attempted, then an unresolved refusal is returned.
It must be distinct from both `local` and `remote`; `sync()` rejects an identical store
object before doing work. Frieren already owns separate shared and private stores.

Frieren passes the profile's private store. Recovery rows live below one reserved
directory in that store, so the feature adds no database, remote route, cursor, or
protocol member.

The option is a store rather than a callback. The engine already owns the refused
page, local versions, blob ordering, and replan loop; asking a host callback to
reimplement those rules would make the public interface shallow and make tests depend
on callbacks rather than observable store state.

### No new `Store` method and no wire change

Recovery uses only `get`, `child`, `children`, `since`, `commit`, and the blob map. The
authority still returns `GuardError` over HTTP. The recovery planner does not parse
its message.

Authority validation will expose a package-internal structured refusal description
which is used by both `authority()` and `engine.ts`. Its shape is not re-exported from
`@justfiles/fs`:

```ts
type TreeRefusal =
	| { kind: 'root'; row: Node }
	| { kind: 'dead-id'; row: Node; held: Node }
	| { kind: 'invalid-parent'; row: Node; parent: Node }
	| { kind: 'stranded-children'; row: Node }
	| { kind: 'duplicate-name'; row: Node; holder: Node }
	| { kind: 'cycle'; row: Node }
```

The exact fields may compress during implementation. The requirement is behavioral:
the authority and recovery planner must classify from the same rule implementation,
not from duplicated checks or error-string parsing. `GuardError.reason` remains a
`Guard | string` on the seam.

The authority runs validation in its existing serialized commit. The engine first
runs the same inspection read-only before transferring blobs, then the authority
repeats it inside the serialized commit. The preflight is an optimisation and privacy
guard, not authority: if state changes between the two, the authority's decision wins.
After a refusal the engine inspects fresh remote state; if the original refusal no
longer describes current state, it replans without mutating local data.

### Classify once, apply one repair

Repairs are not tried speculatively. A refused page is inspected against fresh local
and remote state, exactly one matching plan is selected, and its guarded local commit
is attempted. A guard race restarts classification. A repair which reports success
must have changed local state; otherwise the existing replan budget would turn a bug
into an infinite loop.

The ordered policy is:

| Refusal | Repair |
| --- | --- |
| dead row id | Existing edit/delete revival |
| deleted directory parent | Existing ancestor revival |
| duplicate/taken name | Existing conflict rename |
| invalid non-directory parent | Salvage the rejected child subtree locally, then clean its locally-authored shared rows |
| directory retyped while it has children | Preserve the incoming replacement in recovery; restore the authority's directory on pull |
| parent cycle | Salvage the locally moved branch, then restore the authority's placement on pull |
| invalid root | Replace the local root with the authority's root; root metadata is not user content |
| state changed after refusal | Replan and classify again |
| no classification or no recovery store | Return the original refusal |

The first three remain semantic settlement. They must run before terminal recovery so
valid shared conflicts continue producing shared conflict copies.

### The smallest affected graph

Recovery begins at the row named by the refusal. It scans `local.since()` from the
empty cursor once and builds raw live parent adjacency, then selects the row's
descendant closure. It cannot discover the graph with `children()`: contract rule 1
deliberately hides duplicate-name losers from that visible index. The feed exposes
every row, so a duplicate loser, a child below a file, and a cyclic or detached row
can all be salvaged. The scan keeps the newest version seen for each id; captured
versions guard the later cleanup.

Rows outside that descendant closure are not copied or rewritten merely because they
shared the refused page. Tombstones need no recovery. The root is never copied.

The source graph is not assumed to be a valid tree. Recovery makes a valid forest:

- an edge from a file, symlink, or mount is broken and its child becomes another root
  inside the operation directory;
- a missing or external parent makes the row an operation root; and
- a cycle is broken deterministically at the lowest node id in that cycle; and
- duplicate sibling names are numbered deterministically, with the lowest source id
  retaining the original name.

All other directory edges and names are preserved. A recovered row whose edge or name
was rewritten records its own original parent and name as xattrs, so a future recovery
UI can explain why that item moved without one unbounded operation manifest.

### Copy, verify, clean

Moving between stores cannot be atomic. The operation is therefore ordered so every
crash point is safe:

1. Read the affected subtree and capture the source versions used as guards.
2. Compute an operation id from the refusal kind plus the sorted source `(id,
   version)` pairs.
3. Compute deterministic destination ids and versions from `(operation id, source
   id)`.
4. Copy every locally available blob into the recovery store.
5. Commit the recovered descendants detached; commit the normalised forest roots and
   their `Recovered items/<operation>` parent last.
6. Read the recovered rows and hashes back through the `Store` interface.
7. Only after verification, clean each affected locally-authored shared row with a
   guard on its captured version: restore the authority's live row when that id exists
   there, otherwise write a local tombstone.
8. Throw `Replan`; the next pass pushes the tombstones and pulls the authority's
   canonical rows.

The recovered copy preserves type, mode, timestamps, xattrs, content hash, link
target, every valid source edge/name, and all available bytes. Ids, versions, and the
edges which made the source invalid change.

Copying descendants before attaching their recovered root uses rule 9 deliberately:
detached rows are invisible but safe. A crash cannot expose half a recovered subtree.
Deterministic ids and versions make every repeated write a rule-3 no-op. If an
operation directory already exists, a retry also reuses its recorded display time;
wall-clock time never participates in identity.

If a source row names a blob which is absent locally, recovery asks the remote blob
map. This covers a pulled lazy stub. If neither store has the bytes and the row is a
locally-authored item being removed from the shared replica, salvage fails and the
shared rows remain untouched.

Restoring an authority row rather than tombstoning it is load-bearing. A local
directory-to-file retype can be rejected because the authority's directory still has
children. Pushing a tombstone for that id would delete the canonical directory and
bury its children—the opposite of server-wins. Restoring the authority's row makes it
peer-authored locally, so the push filter skips it.

### Recovery naming and metadata

The private store contains one ordinary directory named `Recovered items`. Each
operation creates one child directory with a stable, readable name:

```text
Recovered items/
	2026-09-01 10-30 - device-ab12/
		<original top-level name>
```

The operation id, refusal kind, triggering row id, triggering parent id, and recovery
time are recorded as xattrs on the operation directory. Identity and idempotence use
the operation id, not the display name. A collision receives the existing numbered-
name behavior. The first successful attachment records the display time; a retry
which finds that deterministic operation id reuses the stored row. A crash before
attachment may choose a later display time because no operation was visible yet.

No manifest file is added. Operation xattrs hold the small recovery metadata, and the
recovered rows remain the source of truth for content and topology.

No automatic retention policy is introduced. A future recovery UI may restore or
delete an operation explicitly.

## Control flow

```text
inspect push page
	|
	+-- refusal known -> semantic or terminal repair -> replan
	|
	+-- no refusal -> transfer blobs -> commit page
		|
		+-- authority accepts -------------------> save cursor
		|
		+-- GuardError
			|
			+-- inspect fresh remote state
				|
				+-- semantic plan -> guarded local rewrite -> replan
				|
				+-- terminal plan
					|
					+-- no recovery store -> original GuardError
					|
					+-- copy graph + blobs to recovery
						|
						+-- verification fails -> error; shared rows unchanged
						|
						+-- guarded cleanup -> replan -> converge
```

Recovery consumes the existing `REPLANS` budget. A successful authority page resets
that budget as it does today. No second retry counter is added.

## Concurrency and crash behavior

| Interruption | Required result |
| --- | --- |
| crash before recovery writes | Original shared rows remain; retry starts again |
| crash after blobs | Only orphan recovery blobs exist; retry reuses them |
| crash after detached recovery rows | No partial recovery path is visible; retry no-ops the rows |
| crash after recovery root | A complete recovery copy is visible; original shared rows still exist |
| crash after shared cleanup | Recovery copy is complete; next sync resumes from the lagging cursor |
| local edit during copy | Source-version guard refuses cleanup; reclassify and recover the newer state; the earlier verified snapshot may remain as a distinct recovery operation |
| remote write after refusal | Fresh inspection returns a different plan or replan; no stale remote assumption is committed locally |
| recovery store error/quota | Original shared rows remain and sync reports error |

## Public behavior and observability

The public success signal is unchanged: `flush()` resolves and `status()` becomes
`synced`. A recovery is not a successful sync until the replanned page reaches the
authority and the subsequent pull completes.

The first implementation logs one concise warning containing the recovery operation
id and item count. It must not log file contents, authentication data, or private
paths. A non-blocking notification/recovery browser is a separate UI slice after the
storage behavior is proven; startup never waits for it.

The existing destructive menu remains available only when automatic salvage fails.

## TDD strategy

Tests exercise public behavior through real in-memory stores. `authority(memStore())`
is the authority, `memStore()` is the local and recovery storage, `volume()` creates
user writes, and `sync()` or `synced()` is the action under test. Tests may wrap a
`Store` only at an external failure boundary to inject a crash or race. They do not
call private classifiers, assert helper call counts, parse error messages, or query a
backend directly.

Each behavior within a slice is one red-green cycle. Do not write a later behavior
before the preceding one is green.

### Slice 1 — tracer bullet: the reported mount refusal

1. **RED:** Extend the existing unresolved-refusal scenario with a recovery `memStore`.
   Run `sync()` and assert that it resolves, the authority has no live child or blob
   from the malformed row, the shared local child is no longer live, and the recovered
   file is readable with its original bytes through `volume(recovery)`.
2. **RED:** Wrap the remote boundary so the parent is a directory during preflight and
   becomes a file immediately before the authority commit. Assert that the actual
   `GuardError` path reaches the same recovered result; the already-transferred blob
   may remain unreachable at the authority.

For each behavior, **GREEN:** add only the shared read-only inspection,
`SyncOptions.recovery`, and single-file invalid-parent salvage it requires. Replan
through the existing loop.

Together these prove both paths—preflight privacy and post-rejection repair—through
classification, local-only copy, shared cleanup, and retry before generalising them.

### Slice 2 — a whole subtree survives

**RED:** Reject a directory containing nested directories, an empty directory, a
file, a symlink, mode/xattr metadata, two files sharing one content hash, and two raw
rows with the same name. Assert both duplicate rows survive under numbered names,
assert the recovered graph through `Volume` and `Store` reads, and assert the
authority never receives a recovery directory.

**GREEN:** Add a paged raw-feed scan, affected-graph extraction, deterministic id
mapping, forest normalisation, metadata copying, and blob deduplication. Keep the
single-leaf path inside the same implementation.

### Slice 3 — recovery is crash-safe and idempotent

Add one failure point at a time:

1. **RED/GREEN:** Blob write succeeds and row commit fails; retry recovers once.
2. **RED/GREEN:** Detached rows land and attaching the recovery root fails; the partial
   copy is invisible and retry completes it.
3. **RED/GREEN:** Recovery is complete and shared cleanup fails; retry does not create
   a second operation for the same captured versions.

The tests assert only visible trees, stored rows through `Store.get`, and final sync
status—not internal step order or call counts.

### Slice 4 — a concurrent local edit wins the recovery race

**RED:** Inject a local edit after recovery reads the source and before it cleans the
shared row. The guard must fail, the newer bytes must survive in the eventual recovery
item, and shared cleanup must not overwrite the newer edit. A recovery snapshot for
the earlier version is allowed: it is additional preserved data, not a duplicate
operation.

**GREEN:** Guard cleanup on every captured source version and let the existing replan
loop reread the page.

### Slice 5 — lazy and missing blobs

1. **RED/GREEN:** The local row is a stub but the remote has its hash; recovery fetches
   and verifies the bytes before cleanup.
2. **RED/GREEN:** Neither side has the locally-authored content; `sync()` rejects and
   leaves every shared row live.

### Slice 6 — every authority refusal has a policy

Refactor authority validation into the shared package-internal structured inspection
only while green. Then add one behavior at a time:

1. directory retyped over children preserves the incoming replacement in recovery;
2. a cycle preserves the locally moved branch in recovery;
3. an invalid root is replaced by the authority's root without a recovery item; and
4. a remote change between rejection and inspection replans without recovery.

After each case, rerun the existing conflict suite to prove create/create,
edit/delete, delete/buried-child, and quiet sync remain unchanged.

### Slice 7 — lifecycle and Frieren wiring

**RED:** Through `synced()`, reproduce the tracer rejection and assert `flush()`
resolves, status becomes `synced`, and a second cycle is silent.

**GREEN:** Add `SyncedProps.recovery` and thread it into `sync()`.

**RED:** In Frieren's profile-session harness, assert the profile's private store is
passed as recovery storage and the shared remote never receives `Recovered items`.

**GREEN:** Wire `entry.private` in `startSync` and add the concise recovery warning.

### Slice 8 — bounded and large cases

Add vertical cases for a graph wider than one raw-feed page, a deep chain, several
independent rejected roots in one page, and continuous local writes exhausting the
existing replan budget. Each case must either converge with one recovery operation per
affected root or return an error without losing shared data.

## Expected file map

Keep the implementation contained. The likely shape is:

- `packages/fs/authority.ts` — share the existing invariant inspection internally;
- `packages/fs/engine.ts` — select semantic repair or terminal salvage;
- `packages/fs/recovery.ts` — subtree copy/verification and deterministic recovery
  identity;
- `packages/fs/engine.conflicts.test.ts` — engine behavior matrix;
- `packages/fs/synced.ts` and `packages/fs/synced.test.ts` — option threading and
  lifecycle behavior;
- `platform/frieren/src/fs.ts` and its existing profile-session tests — private-store
  wiring.

Do not create a recovery package, protocol, database adapter, or public classifier.
If `recovery.ts` remains single-use and clearer inside `engine.ts`, keep it there.

## Execution plan

| Phase | Vertical slices | Deliverable |
| --- | --- | --- |
| 1. Prove | 1 | The production failure self-heals for one file |
| 2. Preserve | 2–5 | Complete subtree, metadata, bytes, races, and crashes are safe |
| 3. Complete | 6 | Every authority invariant has an explicit outcome |
| 4. Integrate | 7 | `synced()` and Frieren recover into the profile's private store |
| 5. Harden | 8 | Pagination and bounded-progress proofs |

Every slice follows RED → minimal GREEN. Refactor only while the focused and existing
conflict suites are green. The interface is reconsidered after the tracer bullet; do
not prebuild the full classifier or recovery copier before the first behavior passes.

## Verification

During each slice, run the narrowest test:

```sh
pnpm vitest run packages/fs/engine.conflicts.test.ts -t '<current behavior>'
pnpm vitest run packages/fs/synced.test.ts -t '<current behavior>'
pnpm vitest run platform/frieren/src/apps/profile-session.test.ts -t '<current behavior>'
```

Before handoff:

```sh
pnpm run format
pnpm run typecheck
pnpm run lint:fix
pnpm run test
```

Review formatter and lint changes before committing them. This feature has no required
UI interaction, so browser verification is unnecessary until a recovery notification
or browser is added.

## Acceptance criteria

- The currently reproducible mount-parent `GuardError` converges automatically.
- Every authority refusal has a tested semantic repair, tested terminal salvage, or a
  documented hard failure which leaves the shared rows untouched.
- Terminal recovery never writes a recovery path or recovered row to the remote tree.
  A refusal found by preflight does not upload its blob either.
- A verified recovery copy exists before any affected shared row is cleaned.
- Recovery preserves complete subtrees, node metadata, and every obtainable blob.
- Retrying after every injected crash point converges without duplicate recovery
  operations for the same source versions.
- A concurrent local edit cannot be overwritten or omitted by a stale recovery plan.
- Omitting `recovery` retains the current `GuardError` behavior for generic consumers.
- Passing the same store object as shared and recovery storage is rejected before
  sync begins.
- Existing conflict, engine, store conformance, migration, mount, and lifecycle tests
  remain green.
- Frieren passes its profile-private store as the recovery target and initial runtime
  startup completes after a successful repair.
