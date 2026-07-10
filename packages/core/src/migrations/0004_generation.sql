-- Volume lineage epoch (docs/sync-reset-generation.md). A single row (id = 1)
-- names the server volume's lineage: a `POST /fs/reset` bumps `generation`,
-- which fences stale writers (push fencing) and drives every other device to
-- re-bootstrap on its next handshake. `reset_id` is the winning reset's
-- client-minted id (disambiguates racing resets); `publishing` is the adopt-mine
-- lock held while a new baseline is being republished (owner-only writes, pulls
-- deferred). It is a SQLite ROW, not DO-KV, so the bump commits in the SAME
-- transaction as the truncate — a crash leaves the old lineage or the new one,
-- never a mix.
CREATE TABLE IF NOT EXISTS fs_generation (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	generation INTEGER NOT NULL,
	reset_id TEXT,
	publishing INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO fs_generation(id, generation, reset_id, publishing) VALUES (1, 1, NULL, 0);
