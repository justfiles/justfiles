-- Journal retention: a time, and a floor.
--
-- The prune keeps one row per path, which means a deleted path keeps its tombstone
-- FOREVER — the journal's floor rises with every path ever created, not with the
-- paths that exist. Now that the snapshot is served from the tree (0008), those
-- tombstones can age out: `fs_path_version` holds the authoritative tombstone set,
-- and a re-bootstrapping replica is served it directly.
--
-- `at_ns` is what a time window compares against; the journal had no clock at all.
-- Backfilled to the migration's own time, NOT to 0: existing rows have unknown
-- ages, and starting their retention clock at deploy is the answer that cannot
-- collect a tombstone a device still needs. It costs one window.
ALTER TABLE fs_path_journal ADD COLUMN at_ns INTEGER NOT NULL DEFAULT 0;

UPDATE fs_path_journal
SET at_ns = CAST(strftime('%s', 'now') AS INTEGER) * 1000000000
WHERE at_ns = 0;

-- Collecting a path's LAST row is what a lagging cursor cannot survive: the rows it
-- has not read are gone, and nothing later supersedes them. This is the seq below
-- which that has happened — a reader resuming under it is answered `410` and
-- re-bootstraps (keeping its local data) instead of silently missing the deletions.
--
-- On `fs_generation` because that singleton row is the volume's own state, alongside
-- the lineage epoch. A reset leaves it: `seq` is AUTOINCREMENT, so it keeps rising
-- past a truncated journal, and the generation bump already forces every client to
-- re-bootstrap.
ALTER TABLE fs_generation ADD COLUMN journal_pruned_below INTEGER NOT NULL DEFAULT 0;
