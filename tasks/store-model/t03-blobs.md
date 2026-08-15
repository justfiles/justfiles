# T3 — Blobs

**Status:** todo
**Phase:** A — the seam
**Depends on:** [T1](t01-store-types-and-memstore.md)
**Context:** [overview](README.md) · [design #3, contract rules 7 and 10](../../kb/fs/fable-design.md)

## Goal

The content map: `has` / `get` / `put` by hash.

## Context

SHA-256 hex via `crypto.subtle` — see `sha256Hex` in `packages/core/src/fs.ts`
for the idiom.

Contract rule 7: blobs are immutable; a local caller is trusted on `put`, but a
store that accepts writes from a peer must verify the hash.

## RED

Extend `packages/fs/store.conformance.ts`:

- `put` then `get` round-trips; `has` answers without fetching.
- Blobs are immutable: a second `put` under the same hash is a no-op.
- A committed row may reference an absent hash (lazy stub) — `get` returns
  `null`, nothing throws.
- An orphan blob (no referencing row) is allowed to exist.
- Export a small helper `verifiedBlobs(blobs)` that rejects a `put` whose bytes
  do not hash to the key — every peer-facing store wraps itself in this later
  (rule 7). Test the reject.

## GREEN

memStore blob map + the helper.

## Done when

Suite green.

Note: the write-ordering rule (blob durable before row commit — contract rule
10) is a CALLER rule, not a store rule. It gets its tests in
[T6](t06-volume-write.md) and [T9](t09-engine-blobs.md).
