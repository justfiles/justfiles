-- Drop the legacy FsOp delta-cursor log. The path-based sync engine
-- (fs_path_journal / fs_path_version, see 0002) fully replaced the
-- deltaUpdates/applyBatch surface, which had no remaining consumer.
-- fs_state only ever held the delta-prune high-water, so it goes too.
DROP TABLE IF EXISTS fs_updates;
DROP TABLE IF EXISTS fs_state;
