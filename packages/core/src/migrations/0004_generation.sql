-- Volume lineage epoch. A single row (id = 1): a `POST /fs/reset` bumps
-- `generation`, which fences stale writers and drives every other device to
-- re-bootstrap on its next handshake. `reset_id` is an
-- advisory "reset in progress" flag (crash-resume identity + UI), not a write
-- lock. A SQLite row, not DO-KV, so the bump commits in the SAME transaction as
-- the truncate — a crash leaves the old lineage or the new one, never a mix.
CREATE TABLE IF NOT EXISTS fs_generation (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	generation INTEGER NOT NULL,
	reset_id TEXT
);

INSERT OR IGNORE INTO fs_generation(id, generation, reset_id) VALUES (1, 1, NULL);
