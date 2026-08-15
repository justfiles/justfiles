# T6 — `storeVolume`: write side

**Status:** todo
**Phase:** B — the two consumers
**Depends on:** [T5](t05-volume-read.md)
**Context:** [overview](README.md) · [design #1 table A + "the two consumers"](../../kb/fs/fable-design.md)

## Goal

Every mutating Volume operation expressed as guarded commits.

## Context

- Design table A rows for writes.
- **The parent-`mtime` rule** (design, `volume(store)` paragraph): the volume
  stamps the parent directory's `mtime` on every create, delete, and rename
  inside it — real filesystems do the same. That bumps the parent row's
  version, which is what lets a batch that enumerated a directory (`rm -r`)
  guard against a concurrent create it did not see. This is a correctness
  mechanism, not cosmetics.
- Contract rule 10: content durable (`blobs.put` resolved) BEFORE the row that
  references the hash is committed.
- `Node.mode` holds permission and special bits only (`0o7777`) — `type` is the
  one place that says what a node is. T5 masks on read, because a peer may send
  anything; every row this task writes must already hold to it. `chmod` takes
  the caller's number, so mask it there too.
- Version format: the engine owns it ([T8](t08-engine-core.md) defines
  author-tagged versions). Until then stamp `local:<counter>`, and take a
  `mintVersion` function so the engine can inject its own later.

## RED

New test file, plus port the intents of `exclusive.test.ts`, `displace.test.ts`,
`append-order.test.ts`, `listdir-vanish.test.ts` to the new volume:

- `writeFile` create: `blobs.put` resolves BEFORE the row commit (assert call
  order with a spy); the name is claimed with a `free` guard; a concurrent
  create of the same name loses cleanly (EEXIST).
- `writeFile` overwrite: version guard on the file row.
- Every create / delete / rename stamps the parent directory's `mtimeNs` and a
  new parent version, in the SAME commit.
- `mkdir` (+ `recursive`), `appendFile` (read-modify-write), truncate via
  `writeFile`, `chmod` / `utimes` (whole-row replace), xattr writes, `symlink`.
- `rename`: exactly three rows committed (the node, both parents) — assert the
  commit size; a displaced target becomes a tombstone in the same commit.
- **Proof test 1 of 4:** a rename of a directory with 4,000 children is ONE
  feed entry for the moved node (plus the two parents). Assert via `since`.
- `rm -r`: enumerate children, commit one batch of tombstones guarded on the
  parent's version; a concurrent create inside the directory makes the batch
  fail; the caller re-enumerates and retries.
- `cp -r`: new ids, reused content hashes, zero `blobs.get` calls for the copy
  itself.

## GREEN

Implement. Delete-then-create mints a NEW id; ids are never rebound.

## Done when

All write tests green. The feed after any operation contains only whole rows —
no partial patch anywhere.
