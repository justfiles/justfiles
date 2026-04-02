ALTER TABLE fs_updates ADD COLUMN source TEXT;

CREATE INDEX IF NOT EXISTS idx_fs_updates_source_seq ON fs_updates(source, seq);
