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
  copy-then-remove. Assert the final state of BOTH stores.
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
- **A watch stays on one store**, the one its path resolves into, and a mount is
  a watch boundary in both directions. To keep it, `changes` now subscribes to
  every feed the volume can reach BEFORE binding, and tags each batch with the
  store it came from — asking which store the path is in first would put a read
  of the tree in front of the subscription, which is the one order that loses an
  event (`volume.store.watch.test.ts` has the case).
- **Ids are unique within a store and nowhere else.** `ROOT` is the same
  constant in every store, so bindings are only read in the store the volume was
  built over, `scan` starts a fresh visited set at every crossing, and a crossed
  `readdir` entry reports the bound root's id — unique per store, the way a POSIX
  inode number is unique per device, and this model has no `st_dev`.

`rm` of a BOUND mount point resolves to the bound store's root and is refused —
`EBUSY` by another name; unbind first. An unbound one is an ordinary row and goes
with it. Renaming a bound mount point moves the row and leaves the binding where
it was pointed, exactly as an fstab entry does.
