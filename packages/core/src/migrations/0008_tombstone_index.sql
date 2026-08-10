-- The tombstone set, as an index.
--
-- `fs_path_version` holds one row per path ever touched, and the sync snapshot now
-- serves the DELETED ones to a re-bootstrapping replica (caps.pathSnapshot). Paging
-- that set through the table's own primary key would walk every LIVE path too — the
-- overwhelming majority — and load each row to test it.
--
-- PARTIAL, so it holds only the deleted paths, and COVERING in `path` order, so a
-- page is one range scan with no table lookups. `tombstone_version >= version` (the
-- "still deleted, not resurrected" test) is answered from the index itself.
CREATE INDEX IF NOT EXISTS idx_fs_path_version_tombstone
	ON fs_path_version(path, tombstone_version, version)
	WHERE tombstone_version > 0;
