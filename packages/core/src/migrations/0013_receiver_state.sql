-- Receiver-private metadata for leased cursors and tombstone retention.
ALTER TABLE nodes ADD COLUMN commit_ms INTEGER;

CREATE INDEX IF NOT EXISTS nodes_tombstone_seq ON nodes(sid, deleted, seq, commit_ms)
	WHERE deleted = 1;
