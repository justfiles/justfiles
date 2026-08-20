# The push-side version guard

> Status: **resolved by deleting the push-side guards.** The pull-side guards remain.
> Found while measuring sync traffic for #541, #542 and #546.

Before the deletion, the engine read the peer's current version for every row it
pushed and used it as a compare-and-set guard on the commit. That read cost a round
trip per row, and it could not detect the conflict it looked like it was there to
detect. This note records why, what it cost, and the three options considered.

## What the code did

`packages/fs/engine.ts`:

```ts
const push = async (rows: Node[]): Promise<void> => {
	await transfer(rows, local.blobs, remote.blobs, PROBE_ABOVE)
	const guards = await bases(remote, rows)
	await remote.commit(rows, guards)
}

async function bases(store: Store, rows: Node[]): Promise<Base[]> {
	return fanned(rows, async (row) => ({
		version: { id: row.id, is: (await store.get(row.id))?.version ?? null }
	}))
}
```

One `get` per row at the peer, eight at a time, then a CAS commit against what those
reads returned. The old module header stated the intent:

> Conflicts are v1's policy and nothing more: reject, then replan. Every commit names
> the base it is replacing, so a conflict arrives as a refusal rather than a silent
> overwrite.

## Why it does not hold

The guard names the version the peer holds *now*, one round trip ago. It does not name
the version this replica's write was based on. Those two values agree only when nobody
else has touched the row since the last agreement with the peer, which is exactly the
case with no conflict in it.

`bases`' own comment is accurate and modest about this. It claims the commit "lands
only if the rows are still what was read", and that is all it does. Read, then write,
with one round trip in between. It guards a window one round trip wide, not a stale
base.

## The lost update

Two devices, both synced, `/notes.txt` at v1.

1. B edits the file, mints v2, pushes. The peer holds v2.
2. A is offline and edits the same file, minting v3 on top of v1. A has never seen v2.
3. A reconnects. Its cycle pushes first. `bases` reads the peer, gets v2, guards on
   v2. The CAS holds, because A is asserting a value it read a millisecond earlier
   rather than v1, the version its edit was actually built from. The commit lands.
4. B pulls v3 and its edit is gone. Nothing was refused, `settle` never ran, nothing
   was logged.

Step 3 is the whole problem. A guard that reads its own expected value immediately
before asserting it can only fail by coincidence.

## Even a firing guard changes nothing

`settle`, on an edit collision:

```ts
// EDIT vs EDIT needs no fix. The row is still this row at the peer; what moved
// is the base under it, and the re-push reads the new one. Last writer wins,
// and this replica is now the last writer.
```

So a version refusal resolves to "read again and overwrite", one cycle later. The tree
ends up where it would have without the guard.

Every refusal that changes an outcome comes from `authority.ts`, and none of them
consults the guards the engine sends: a tombstone is final, a parent must be a live
directory, a name is taken, a row cannot become its own ancestor, a directory holding
children cannot change type. Those produce the renames and recreations `settle` exists
for.

The push-side version guard is decoration. I could not find a case where it changes
what the tree converges to.

## What it costs

One `get` at the peer per row pushed. After #541 batched the round trips into lanes and
#546 dropped the blob probe, it is the last per-row network cost left in the engine.

Measured in the browser, opening Notes and letting its state writes push: 15 store
requests, of which 6 were `GET /store/node`. In a cycle with no refusals that is
`bases` and nothing else, because `settle` only reads when a commit is refused. Six
requests out of fifteen, enforcing nothing.

The idle cost is zero, and that part of the design works: the push filter (`mine`)
leaves the steady state with no rows, so no rows means no reads. The cost lands
squarely on writing.

## Three ways out

### Delete it

Push with no version guards. Edits become last-writer-wins by declaration instead of by
accident, the authority stays the only thing that refuses, and `settle` keeps handling
the refusals that matter. A push becomes one commit plus its blob PUTs.

The header prose has to change to say what the code does, and that is the real win.
Claiming a protection that is not there is worse than not claiming one.

### Build the base cache

A local side table, per node id, holding the version this replica last agreed with the
peer on. The pull writes it when it applies a row, a successful push writes it for the
rows that landed, and a local edit leaves it alone while minting a new version. Then
`bases` is a local lookup: the round trip per row disappears, and the guard means what
the header says. Step 3 above becomes a real refusal.

That second half deserves emphasis. The base cache is filed in the design as what a
future three-way field merge needs, so it reads as pure future work. It is also the
only way to make a push cheap. A base you remember costs nothing to state. A base you
go and ask for costs a round trip and answers the wrong question.

The catch is that a real refusal needs a real policy. If `settle` answers an edit
collision by adopting the peer's version and re-pushing, the result is today's
last-writer-wins plus a table to maintain, which buys nothing. To be worth building,
the refusal has to do something a user can see: keep both sides as a conflict copy, or
merge per field. That is design work, not a patch.

Note also that a base cache must survive a restart to be useful, and a missing entry
has to fall back to reading the peer rather than to guarding on `null`, which would
refuse every row that already exists.

### Leave it

Keep paying 6 requests in 15 for a guard that fires on a one-round-trip coincidence and
resolves to an overwrite when it does. Defensible only if conflict policy is about to be
reopened and you would rather change this once.

## Recommendation

Delete the push-side guards now, and file the base cache as one issue covering both the
guard and the conflict policy, because neither is worth doing without the other. Small
deletion, a measurable speedup on every write, and the documentation stops
overpromising.

The pull side keeps its guards. There the read is local and free, and the race it
catches is real: the volume writes while the sync loop runs, and the guard is what
sends the loop back through the push that carries the new local write.

## Outcome

The engine now pushes rows with `remote.commit(rows)`. It no longer reads each row
from the peer or sends version guards with a push. Edit conflicts are explicitly
last-writer-wins. The authority still refuses invalid tree changes, and `settle`
still handles those refusals. Pull still reads local bases and commits with guards.

## Where this sits in the investigation

- #541, merged. Round trips batched into 8 lanes, own-push echoes dropped in `pull`,
  one replica per profile. A 20-file push at 60ms injected latency went from 4053ms to
  650ms.
- #542, merged. A hosted app's warm covers the two files its manifest names rather than
  every file it mounts. 510 fetches per page load down to 41.
- #546, merged. No `HEAD` before a `PUT` under 64KB, because the probe missed 100% of
  the time and cost a round trip each.
- This note, resolved by deleting the push-side guards.

Related: #544, App Code's SDK is 236 of 246 mounted files against a 500-entry cache.
