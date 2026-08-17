# T15 — Mounts

**Status:** todo
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
