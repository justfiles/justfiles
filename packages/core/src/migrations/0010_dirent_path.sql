-- The directory entry's canonical path, as a real column.
--
-- Paths were derived, never stored. `pathOf` walked UP the dirent chain with a
-- recursive CTE on every single-file mutation, and the tree walk (TREE_CTE) rebuilt
-- the WHOLE tree on every page — so a paged scan was quadratic in the page count.
-- That is no longer only a scan-path cost: `pathSnapshot.puts` is the snapshot every
-- new device pages through, and it walked the same CTE per page.
--
-- Stored, a page is an index range scan over this column, and the CTE leaves the
-- write path entirely.
--
-- The usual objection is that a directory rename must rewrite every descendant.
-- That cost is already paid: `atomicMove` enumerates the subtree to journal the
-- rename as an ordered delete + put of every descendant, so those rows are already
-- walked and already get a journal row each. One indexed range UPDATE beside that
-- is marginal.
--
-- Nullable, like `fs_path_journal.path` (0007): SQLite cannot add a NOT NULL column
-- without a constant default. Here NULL is not "missing", it is MEANINGFUL — the
-- entry is not reachable from the root, which is exactly what the recursive walk
-- said by not finding it. Every reader compares `path > ?`, which is never true of
-- NULL, so such an entry stays out of the scan exactly as before.
ALTER TABLE fs_dirents ADD COLUMN path TEXT;

-- Backfill with the walk the reads used to do per page, once. The root ino is '1'
-- (ROOT_INO in storage.sqlite.ts) and has no dirent row of its own; an entry the
-- walk never reaches keeps its NULL.
WITH RECURSIVE tree(path, ino, dir_ino, name) AS (
	SELECT '/' || name, ino, dir_ino, name
	FROM fs_dirents
	WHERE dir_ino = '1'
	UNION ALL
	SELECT tree.path || '/' || child.name, child.ino, child.dir_ino, child.name
	FROM tree
	JOIN fs_dirents child ON child.dir_ino = tree.ino
)
UPDATE fs_dirents
SET path = (
	SELECT tree.path FROM tree
	WHERE tree.dir_ino = fs_dirents.dir_ino AND tree.name = fs_dirents.name
)
WHERE path IS NULL;

-- Serves the keyset page: `WHERE path > ? ORDER BY path LIMIT ?`, which is the whole
-- of `fullScan` and of the snapshot's put phase.
--
-- NOT unique, though a consistent tree never repeats a path. Uniqueness is a
-- property of the inode graph, not of this table: detach a non-empty directory's
-- entry and its descendants keep paths nothing can reach, where a UNIQUE index would
-- fail the write that later recreates that name. Storage does not police that state
-- elsewhere, so it does not fail a user's write for it here.
CREATE INDEX IF NOT EXISTS idx_fs_dirents_path ON fs_dirents(path);
