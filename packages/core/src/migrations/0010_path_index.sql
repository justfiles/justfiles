-- The sync layer's path index: canonical path -> inode.
--
-- WHAT IT IS FOR, and why it is not a column on fs_dirents. The snapshot a
-- bootstrapping device pages through (`pathSnapshot.puts`) needs the tree in a
-- SORTED, RESUMABLE total order. It derived that order with a recursive CTE that
-- rebuilt the whole tree on every page, so paging a snapshot was quadratic in the
-- page count — 202 ms against 4040 entries where this index costs 10 ms.
--
-- But "every path in sorted order, paginated" is not a filesystem operation. No
-- filesystem has it; `readdir` is per directory, and `pathOf` is a walk UP the
-- parent chain (O(depth) — exactly what `d_path()` does in the Linux dcache, which
-- stores no paths at all). It is a SYNC query, so it gets a sync table beside
-- fs_path_journal and fs_path_version, and the inode graph keeps its POSIX shape.
--
-- That split is the point, not tidiness. This table is DERIVED: drop it and the
-- filesystem is unharmed — reads, writes, renames and `volume.walk` all still work,
-- and the statement below rebuilds it from the tree. A path column on fs_dirents
-- could not be dropped, because it would BE the tree.
--
-- No foreign key to fs_inodes, deliberately. `ON DELETE RESTRICT` (what fs_dirents
-- uses) would let stale sync state block an inode delete, and the whole claim above
-- is that removing this table can never break the filesystem.
CREATE TABLE IF NOT EXISTS fs_path_index (
	path TEXT PRIMARY KEY,
	ino TEXT NOT NULL
);

-- Backfill (and the rebuild recipe): walk the tree once. The root ino is '1'
-- (ROOT_INO in storage.sqlite.ts) and has no entry of its own. An entry the walk
-- cannot reach from the root has no canonical path and gets no row — the same
-- answer the walk gave the readers by never reaching it.
WITH RECURSIVE tree(path, ino) AS (
	SELECT '/' || name, ino
	FROM fs_dirents
	WHERE dir_ino = '1'
	UNION ALL
	SELECT tree.path || '/' || child.name, child.ino
	FROM tree
	JOIN fs_dirents child ON child.dir_ino = tree.ino
)
INSERT INTO fs_path_index(path, ino)
SELECT path, ino FROM tree
WHERE true
ON CONFLICT(path) DO NOTHING;
