-- Volume lineage epoch (docs/sync-reset-generation.md). A single row (id = 1)
-- names the server volume's lineage: a `POST /fs/reset` bumps `generation`,
-- which fences stale writers (push fencing) and drives every other device to
-- re-bootstrap on its next handshake. `reset_id` is an ADVISORY "a reset /
-- republish is in progress" flag: set by the reset that produced this
-- generation, cleared once the initiator's republish drains. It is NOT a write
-- lock (the republish rides ordinary sync) -- it drives crash-resume identity
-- and UI legibility. It is a SQLite ROW, not DO-KV, so the bump commits in the
-- SAME transaction as the truncate -- a crash leaves the old lineage or the new
-- one, never a mix.
CREATE TABLE IF NOT EXISTS fs_generation (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	generation INTEGER NOT NULL,
	reset_id TEXT
);

INSERT OR IGNORE INTO fs_generation(id, generation, reset_id) VALUES (1, 1, NULL);
