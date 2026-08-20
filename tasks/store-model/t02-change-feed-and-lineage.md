# T2 — The change feed: `since` + cursor lineage

**Status:** done
**Phase:** A — the seam
**Depends on:** [T1](t01-store-types-and-memstore.md)
**Context:** [overview](README.md) · [design #3, contract rules 4, 5, 11](../../kb/fs/fable-design.md)

## Goal

The feed semantics of contract rules 4 (self-compacting feed), 5 (cursors are
replica-private), and 11 (lineage fencing) — in the conformance suite and in
memStore.

The feed is an INDEX over the one table, not a journal. No journal rows exist
anywhere.

## RED

Extend `packages/fs/store.conformance.ts`:

- `since()` from the empty cursor returns every live row and every tombstone,
  paged.
- Each node appears at most once per scan, at its latest committed state.
- An update moves the node to the end of the order: a resumed cursor sees it
  again with newer state; it never permanently misses a node.
- A commit during a paged scan is safe: the changed row reappears later in the
  scan (write mid-scan, keep paging, assert convergence).
- A cursor from a different store instance (new lineage) is rejected with a
  typed error (`ForeignCursorError` or similar — pick one name and export it).
  The caller restarts from the empty cursor and converges.
- `subscribe`, when present, fires once per commit with the committed rows,
  AFTER the commit.

## GREEN

memStore: a monotonic sequence per commit; `since` scans rows ordered by their
latest sequence; a lineage id minted per store instance, embedded in the cursor.

## Done when

Suite green on memStore. Grep the diff: no journal table, no journal rows — the
feed is an index over the one table.
