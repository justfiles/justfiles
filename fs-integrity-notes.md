# FS Sync Integrity Notes

## Problem Shape

There are two different classes of sync failure:

1. Feed validity failure:
	A stored cursor is no longer usable against the source feed because the source has pruned or reset history.
2. Local replica integrity failure:
	The cursor is still valid, but the local cached namespace is incomplete or corrupted, so resuming incremental sync from that cursor can silently preserve wrong local state.

The current worker-side remote feed already handles the first class:

- the SQLite backend tracks how far `fs_updates` has been pruned and throws `FsCursorExpiredError` when a client asks for a cursor older than the retained history in [`packages/core/src/storage.sqlite.ts`](./packages/core/src/storage.sqlite.ts)
- the HTTP API maps that to `409 { code: "cursor_expired" }` in [`packages/core/src/fs.ts`](./packages/core/src/fs.ts)
- the client turns that into a full namespace bootstrap in [`packages/fs/storage.cached.ts`](./packages/fs/storage.cached.ts)

That is enough for "remote history gap" handling.

It does **not** prove that the local cached namespace is complete.

## Concrete Failure Mode

Example:

1. Local bootstraps `a.txt` and `b.txt` and stores `remoteCursor = 100`.
2. Local IndexedDB later loses `b.txt` because of a partial clear, corruption, or a cache bug.
3. Remote history after `100` only contains changes to `a.txt`.
4. The next pull from `100` is still valid.
5. Remote never mentions `b.txt` again because it predates the cursor.
6. Local remains silently incomplete forever.

That is why there is now a startup root-level consistency check in [`packages/fs/storage.cached.ts`](./packages/fs/storage.cached.ts): it is a stopgap to avoid trusting an obviously incomplete bootstrapped namespace snapshot.

## Current Stopgap

The current protection is intentionally narrow:

- compare local root entries against remote root entries in both directions
- if they do not match exactly, discard the persisted bootstrap state and run a full bootstrap again

This is cheap enough for the current repo, but it is still heuristic:

- it only checks the root namespace
- it does not validate deeper subtree completeness
- it does not give a formal proof that the whole local replica is intact

## Better Long-Term Directions

### 1. Feed Validity Metadata

One useful separation is:

- feed validity: "is this cursor still meaningful for this source?"
- local integrity: "is this cached replica complete enough to resume from that cursor?"

For feed validity, a sync-capable backend can expose source-owned feed state such as:

- `sourceId`: identity of the feed owner
- `epoch`: identity of the feed lineage / reset generation
- `retentionFloor`: oldest cursor still incrementally replayable
- `head`: newest known cursor

This should belong to the sync feed, not to the generic filesystem abstraction.

### 2. Persisted Namespace Summary

For local integrity, the simplest stronger mechanism is:

- compute a canonical summary/hash of the bootstrapped namespace snapshot
- persist it locally together with the cursor
- refuse to trust the local snapshot if the summary no longer matches

This is a better long-term fit than accumulating more ad hoc startup checks.

### 3. Subtree / Merkle Anti-Entropy

If the tree becomes large enough that a full namespace summary or bootstrap is too expensive, the next step is subtree anti-entropy:

- compute hashes per directory / subtree
- compare from the root downward
- only descend into mismatched subtrees

That is the classic anti-entropy pattern used in distributed storage systems.

## Why This Is Different From Rsync

Rsync-style rolling checksums are about efficient **file content delta transfer**. They are useful once you already know which file bytes differ.

They do not solve:

- "is my cached namespace missing an old file that predates my current cursor?"

So this integrity problem is about replica state validation, not rolling content-diff transfer.

## References

- CouchDB `_changes` feed: incremental change feed semantics, including the fact that clients should not expect every intermediate state to be replayed  
	https://docs.couchdb.org/en/latest/api/database/changes.html
- CouchDB replication protocol and checkpoints  
	https://docs.couchdb.org/en/stable/replication/protocol.html
- Syncthing BEP v1: index IDs and sequence-based index exchange  
	https://docs.syncthing.net/specs/bep-v1.html
- Riak active anti-entropy overview  
	https://docs.riak.com/riak/kv/latest/learn/concepts/active-anti-entropy/index.html
- Unison paper / design background  
	https://repository.upenn.edu/handle/20.500.14332/7325
- Rsync rolling checksum note  
	https://rsync.samba.org/tech_report/node3.html
