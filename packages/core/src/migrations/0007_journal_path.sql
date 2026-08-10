-- The journal row's path, as a real column.
--
-- The daily prune coalesces the journal to one row per path, and it found that
-- path by re-parsing `change_json` with `json_extract` on every row: a full scan
-- plus a temp b-tree for the grouping, because no index can serve a computed
-- expression. An expression index would fix the read but move the extraction onto
-- every INSERT, and the journal is on the write path of every mutation — the wrong
-- trade. `appendJournalRow` already holds the path, so it writes it here instead
-- and the prune becomes an index range scan.
--
-- Nullable because SQLite cannot add a NOT NULL column without a constant default.
-- The backfill fills every existing row and the writer always supplies one, so a
-- NULL path is not reachable after this migration.
ALTER TABLE fs_path_journal ADD COLUMN path TEXT;

UPDATE fs_path_journal SET path = json_extract(change_json, '$.path') WHERE path IS NULL;

-- (path, seq) — the prune asks "the newest seq for this path" and nothing else.
CREATE INDEX IF NOT EXISTS idx_fs_path_journal_path_seq ON fs_path_journal(path, seq);
