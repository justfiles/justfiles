# Store model — overview

Source design: [kb/fs/fable-design.md](../../kb/fs/fable-design.md). Read its
sections **#2 (data structures)** and **#3 (the seam)** before you start any
task. This file holds the context every task shares; each task file holds only
what is specific to it and points back here.

## The problem

The system keeps two models of the same data. `packages/fs` speaks disk-FS:
`Ino`, dirent store, `InodeMeta`, blob-per-inode. `packages/sync` speaks sync:
`SyncNodeId`, `parentId + name`, revisions, journals. Neither model can see the
other, so every feature pays a translation tax — an ino↔nodeId mapping,
mutation observers, journal stores, snapshot sessions, a 4-row capability
matrix, and "parents before children" wire ordering.

## The goal

One model. A single `Store` seam that is both the storage API and the wire.
One table, two lookups, one order, one guarded atomic write, one hash-keyed
blob map. POSIX becomes a view over it; sync becomes a small loop beside it.

## Do we keep a separate `packages/sync`?

No. The new engine is one small module (`engine.ts`) over the `Store` seam, and
it lives in `packages/fs`. Two parts stay outside:

- The SQLite `Store` backend and the Hono route adapter stay in
  `packages/core`. They are server code. `packages/fs` must stay
  dependency-free; `core` depends on `fs`, never the reverse.
- `packages/sync` is deleted in the last task only, after every consumer has
  moved. They all have as of [T17](t17-swap-consumers.md): what still references
  it is `packages/core`'s migration fixture, which is the proof the one pass
  works and so leaves with the pass.

## Ground rules — every task

- **RED first.** Write the failing test. Run it. See it fail for the right
  reason. Then implement. Then see it pass.
- New code goes into `packages/fs` as NEW files. New files must not import the
  old vocabulary (`storage.ts`, `Ino`, `InodeMeta`, `MutationOptions`). The old
  code keeps working until the swap task.
- Tools: pnpm, vitest, node, tab indentation. Run tests with
  `pnpm vitest run <file>` in the package directory. Run `pnpm typecheck`
  before you finish.
- One branch + worktree per task — see [Branching](#branching) below, which
  overrides the default base branch in [CLAUDE.md](../../CLAUDE.md).
- Export only what the next task needs. Nothing more.
- When you finish a task, tick its row in the progress table below and set its
  status line at the top of the task file.

## Branching

**`redesign` is the main branch for this whole story. Not `main`.**

The story lands as one large change across many tasks, and the intermediate
states are not shippable — the twin vocabulary runs side by side until
[T17](t17-swap-consumers.md), and the old packages only disappear in
[T18](t18-retire.md). So the tasks integrate on `redesign`, and `redesign`
merges into `main` once when the story is complete.

For every task:

- **Branch off `redesign`**, never off `main`.
- **Open the PR against `redesign`**, never against `main`.
- **Rebase on `redesign`**, not on `main`, when you need to catch up.

```sh
git fetch origin
git worktree add ../justfiles.worktrees/<task> -b <branch> origin/redesign
```

Worktrees live in the sibling folder `../justfiles.worktrees/`. After you
create one, seed the git-ignored local dev files — `git worktree` checks out
tracked files only, so local runs break without them. The list is in
[CLAUDE.md](../../CLAUDE.md); copy each file from the main checkout to the same
path in the new worktree.

If a task builds on an unmerged task (see the `Depends on` column), branch off
that task's branch instead and target it with the PR, so the diff stays
readable. When the parent merges into `redesign`, rebase onto `redesign` and
retarget the PR.

## Progress

Status values: `todo`, `in progress`, `done`, `blocked`.

### Phase A — the seam

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| T1 | [Store types, memStore, conformance suite](t01-store-types-and-memstore.md) | — | done |
| T2 | [The change feed: `since` + cursor lineage](t02-change-feed-and-lineage.md) | T1 | done |
| T3 | [Blobs](t03-blobs.md) | T1 | done |
| T4 | [IndexedDB Store — the kill criterion](t04-indexeddb-store.md) | T1–T3 | done |

### Phase B — the two consumers

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| T5 | [`storeVolume` — read side](t05-volume-read.md) | T1–T3 | done |
| T6 | [`storeVolume` — write side](t06-volume-write.md) | T5 | done |
| T7 | [`watch` from the feed](t07-watch.md) | T6 | done |
| T8 | [Engine core: pull, push, cursors](t08-engine-core.md) | T1–T3 | done |
| T9 | [Engine: blob transfer + lazy content](t09-engine-blobs.md) | T8 | done |
| T10 | [Authority + conflict policy](t10-authority-and-conflicts.md) | T8 | done |
| T11 | [Lifecycle wrapper — the `synced()` surface](t11-lifecycle-wrapper.md) | T8–T10 | done |

### Phase C — backends and wire

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| T12 | [SQLite Store (server)](t12-sqlite-store.md) | T1–T3 | done |
| T13 | [HTTP wire: `storeApi` + `httpStore`](t13-http-wire.md) | T1–T3, T10 | done |
| T14 | [Native FS Store](t14-native-fs-store.md) | T1–T3 | done |

### Phase D — namespace, migration, swap, retire

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| T15 | [Mounts](t15-mounts.md) | T6, T13 | done |
| T16 | [Data migration](t16-data-migration.md) | T4, T12 | done |
| T17 | [Swap the consumers](t17-swap-consumers.md) | T11, T13, T15, T16 | done |
| T18 | [Retire the twin vocabulary](t18-retire.md) | T17 | done |

### Optional — take it or leave it

Not on the critical path. Nothing above waits for these, and the story ships
without them.

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| T19 | [The sidecar stops being one file](t19-sidecar-write-amplification.md) | T14 | optional |

### Follow-up — self-healing

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| T20 | [Self-heal rejected sync pages](t20-rejection-recovery.md) · [decision graph](t20-rejection-recovery.html) | T10, T11, T15 | todo |

### Follow-up — bounded history

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| T21 | [Expire feed cursors and sweep tombstones](t21-cursor-leases-and-tombstone-gc.md) | T8, T12, T13, T17 | done |

## Dependency map

```
T1 → T2 → T3 → T4 (kill criterion — do early)
              ↘
T1..T3 → T5 → T6 → T7            (volume)
T1..T3 → T8 → T9 → T10 → T11     (engine)
T1..T3 → T12 (SQLite)  T13 (HTTP) T14 (native FS)
T6 + T13 → T15 (mounts)
T12 + T4 → T16 (migration)
T11 + T13 + T15 + T16 → T17 (swap) → T18 (retire)
T10 + T11 + T15 → T20 (self-heal rejected pages)
T8 + T12 + T13 + T17 → T21 (signed cursors + tombstone GC)
```

## The seam, for reference

Copy the authoritative types from design #2 and #3. Reproduced here so a task
file can point at one place:

```ts
type NodeId = string   // UUID. Minted once, never rebound. Root is a constant.
type Hash = string     // SHA-256 of content bytes, hex.
type Version = string  // Opaque to storage. The engine owns its meaning.
type Cursor = string   // Opaque, minted by the store whose feed it resumes.

type Node = {
	id: NodeId
	parent: NodeId
	name: string
	type: 'file' | 'dir' | 'symlink' | 'mount'
	mode: number
	mtimeNs: bigint
	size: bigint
	xattrs?: Record<string, Uint8Array>
	content?: Hash
	link?: string
	version: Version
	deleted?: true
}

type Page = { nodes: Node[]; next?: Cursor }

type Guard =
	| { free: { parent: NodeId; name: string } }
	| { version: { id: NodeId; is: Version | null } }

interface Store {
	get(id: NodeId): Promise<Node | null>
	child(parent: NodeId, name: string): Promise<Node | null>
	children(parent: NodeId, cursor?: Cursor): Promise<Page>
	since(cursor?: Cursor): Promise<Page>
	commit(writes: Node[], guards?: Guard[]): Promise<void>
	blobs: {
		has(hash: Hash): Promise<boolean>
		get(hash: Hash): Promise<Uint8Array | null>
		put(hash: Hash, data: Uint8Array): Promise<void>
	}
	subscribe?(listener: (writes: Node[]) => void): () => void
	gc?(): Promise<{ reclaimed: number; done: boolean }>
}
```

The 11 contract rules live in design #3 under "Contract". Task files cite them
by number.

## The four proof tests

The design names four proofs the model must show (end of fable-design.md).
They are spread across the tasks; do not let them slip:

1. A rename of a directory with 4,000 children is one row in the feed — **T6**.
   **Shown in T6:** three rows, and only three — the moved node and the two
   parents whose mtime it stamped. The children never move.
2. A crash between `blobs.put` and `commit` leaves only an orphan blob — **T9**.
   **Shown in T9:** on the push, where it matters — the peer holds the bytes and
   not the row, the cursor never moved, and the re-run transfers nothing. On the
   pull the order is reversed on purpose: the peer still holds the bytes, so a
   row may land ahead of them and a gap is one fetch away, which is what lazy
   content is.
3. A deleted cursor re-applies a page into pure no-ops — **T8**.
   **Shown in T8:** both stores stay silent through the whole re-scan — no row
   written, no feed position taken — so a lost cursor costs a scan and nothing
   else. The same mechanism carries the crash between a commit and its save.
4. A foreign-lineage cursor is rejected and bootstrap converges — **T8**.
   **Shown in T8:** on both sides. A fenced cursor is not retried — no position
   answers to it, ever — so the engine bootstraps and saves a live cursor.

Plus the kill criterion in **T4**: if guarded batch commits cannot be atomic on
IndexedDB within its transaction lifetime rules, STOP and report — the seam,
not the engine, must change, and the design is wrong. **Settled in T4: they
can, with no workaround.** The seam stands; the rest of the story may build on
it.
