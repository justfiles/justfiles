# T15 — Mounts

**Status:** done
**Phase:** D — namespace, migration, swap, retire
**Depends on:** [T6](t06-volume-write.md), [T13](t13-http-wire.md)
**Context:** [overview](README.md) · [design #3, "The namespace: local data without ignore rules"](../../kb/fs/fable-design.md)

## Goal

Local-only data without ignore rules. This is the task that deletes the whole
PR-494 problem class.

## Context

Read the design's entire "The namespace" section before starting — all four
bullets (announced mounts, silent mounts, per-replica content, globs).

The key structural facts:

- A `mount` node is an ordinary row. It claims its name through the ordinary
  `free` guard, and since only a directory can be a parent, it can never have
  children — so a `/private` subtree cannot exist in the synced store at all,
  on any replica, buggy or not. The boundary is enforced by the DATA, not by
  policy code. **Already landed in [T10](t10-authority-and-conflicts.md):**
  `authority.ts` refuses a row whose parent is a mount, and refuses a root that
  is one. Note its `holdsRows` is deliberately NOT `volume.store.ts`'s `isDir`,
  which counts a mount — a junction stands where a directory would for
  resolution and `stat`, and holds nothing in THIS store. Do not merge the two.
- The mount POINT is shared data; the BINDING is local, like fstab.
- A sync engine receives one store and nothing else, so no delta, tombstone, or
  blob request can even name local data.

## RED

- A `mount`-type node claims its name via the normal `free` guard; nothing else
  can occupy it; it can never have children in the synced store.
- `storeVolume(store, bindings)` crosses into the bound store during
  resolution; operations inside the mount hit only the bound store.
- An unbound mount reads as an empty read-only directory.
- Cross-store rename returns `EXDEV`; the volume's `rename` falls back to
  copy-then-remove for one row. Assert the final state of BOTH stores.
- Silent binding: an overlay entry `(parentId, name) → store`, checked during
  resolution BEFORE the synced-row lookup. Synced rows under that name stay
  shadowed, their blobs are never fetched, and removing the binding reveals the
  shared data intact.
- Sync isolation: run the [T8](t08-engine-core.md) engine on the outer store
  only; nothing from the mounted store appears in any page or blob request.
- Per-replica content: a synced symlink targeting a path inside a local mount
  resolves to different bytes on two replicas — the Unix `/etc` convention, and
  the clean shape for `.env`-style secrets.

## GREEN

Mount crossing lives inside `volume.store.ts`. Bindings are plain constructor
data — no policy module, no router.

## Done when

All green. Grep the diff: no glob, no path-prefix configuration, and no
"ignore" identifier anywhere.

## What landed

`storeVolume(store, { bindings })`, where `Bindings` is
`Map<NodeId, Map<string, Store>>` — fstab as data, keyed by the mount POINT
`(parent, name)` rather than by the mount row's id, because a silent binding has
no row to key on. Announced and silent are then one mechanism: the binding is
read BEFORE the row lookup, so a bound name never reaches the table underneath.
An announced mount's own row is never even read during resolution — a kernel
reports the mounted root's inode for a mountpoint, not the directory beneath it.

Three things the RED list did not spell out, decided here:

- **The volume is no longer a view over ONE store.** Every read and every commit
  goes to the store the path resolved into, so `resolve` returns
  `{ store, node }` and each helper takes the store explicitly. `readdir` and
  `scan` cross too, through one `entriesOf` — a binding shadows the row of the
  same name, so a listing can never contradict what resolving that name gives.
  `descendants` deliberately does NOT cross: it is the list of rows a delete is
  about to tombstone in one store.
- **A watch listens to every feed**, and keeps each id it remembers WITH the
  store that minted it. `changes` subscribes to all of them before binding — a
  watch is armed before it may read the tree, so it cannot ask which store the
  path is in first — and tags each batch with its store. A recursive watch still
  does not climb out of a mount, so one above a mount is not told what happens
  inside it.
- **Ids are unique within a store and nowhere else.** `ROOT` is the same
  constant in every store, so bindings are only read in the store the volume was
  built over, `scan` starts a fresh visited set at every crossing, and a crossed
  `readdir` entry reports the bound root's id — unique per store, the way a POSIX
  inode number is unique per device, and this model has no `st_dev`.

A rename that crosses a mount does two things differently from the first cut,
after eight review findings that were all the same operation.

It does not go through `cp`. `cp` chooses what to carry, writes THROUGH a
destination symlink, and merges into a directory instead of taking its place, so
a rename built out of one diverges once per field and once per rule.
`moveAcross` moves ROWS, stating the rule once —
`{ ...row, id: fresh, parent, name, version }` — so nothing is enumerated and
nothing can be left out.

And it only ATTEMPTS what is two commits and no more: one row into a free name,
then that row's tombstone. A directory is a commit per row across two stores with
no guard spanning them, so anything that stops it — a lazy row whose blob never
arrived is enough — leaves half a subtree standing where nobody asked for it. A
taken destination cannot be replaced across two commits either. Both keep the
`EXDEV`, which is what `rename(2)` answers for every cross-device rename,
emulation being userspace's job there. The design doc's sentence is narrowed to
match.

The tombstone is guarded on the row that MOVED, not on whatever the path holds
by then: re-reading it would remove a concurrent writer's newer file and leave
the snapshot standing at the destination. A guard that will not pass leaves a
copy with its removal refused — a `cp` whose `rm` failed, which the caller can
see and finish.

`volume.store.mounts.test.ts` holds the pair to one of two answers, over a
PRODUCT of source kinds and destination kinds rather than a list of cases: it
did what the one-store rename did, or it refused with `EXDEV` and left
everything exactly as it was.

`rm` of a BOUND mount point resolves to the bound store's root and is refused —
`EBUSY` by another name; unbind first. A rename answers the same on either end,
and has to ask the binding itself: both ends read their last component straight
out of the table, which resolution never does — it reads the binding BEFORE the
row, and there is no row there to read it before. An unbound mount is an ordinary
row and moves and goes like one.
