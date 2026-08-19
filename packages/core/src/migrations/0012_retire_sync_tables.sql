-- The old sync engine's tables, dropped. Nothing reads them: the store model keeps
-- its whole order in `nodes.seq` (store.sqlite.ts), so a journal, a per-path version
-- generator, a node clock and an operation log are all one index now. `fs_content_fts`
-- goes with them — only the old backend ever wrote it.
--
-- A NEW migration rather than an edit to 0002/0010/0011, because those already ran: a
-- live volume's schema is what its applied migrations left behind, and editing an
-- applied file changes only what a FRESH database gets. 0007/0008/0009 also ALTER and
-- INDEX these tables, so a fresh database has to create them before this drops them --
-- which costs one statement each, once, and keeps the history honest.
--
-- What deliberately STAYS: `fs_inodes`, `fs_dirents`, `fs_xattrs`, `fs_contents` and
-- `fs_sync_nodes`. They are what the one pass reads (migrate.sqlite.ts), and it runs on
-- a volume's FIRST boot after the swap -- which for a volume nobody has opened yet has
-- not happened. Dropping them would delete that volume instead of migrating it.
DROP TABLE IF EXISTS fs_node_journal_mutations; -- FK into fs_node_journal, so first
DROP TABLE IF EXISTS fs_node_journal;
DROP TABLE IF EXISTS fs_node_clock;
DROP TABLE IF EXISTS fs_node_operations;
DROP TABLE IF EXISTS fs_path_journal;
DROP TABLE IF EXISTS fs_path_version;
DROP TABLE IF EXISTS fs_content_fts;

-- The journal prune's two bookmarks on the singleton lineage row. They went with the
-- journal; the rest of `fs_generation` is the volume's live lineage state (reset.ts).
ALTER TABLE fs_generation DROP COLUMN journal_coalesce_path;
ALTER TABLE fs_generation DROP COLUMN journal_pruned_below;
