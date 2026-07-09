-- Path-based sync: the write-intercept journal + the per-path version generator.
-- Applied on DO init via coreMigrations (see migrations/index.ts). The engine
-- reads fs_path_journal on push (readFrom/head) and fs_path_version drives the
-- deterministic LWW version stamping. See the SQLITE PATH-SYNC EPIC roadmap in
-- storage.sqlite.ts.

-- Append-only, path-stamped, seq-ordered log. `seq` is this backend's SyncCursor.
-- `local_source` tags who applied a row locally (REMOTE_SOURCE on a pull) so a
-- replica can suppress its own echoes; NULL for the backend's own writes.
-- `change_json` is the wire PathChange (put/delete), stored verbatim.
CREATE TABLE IF NOT EXISTS fs_path_journal (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	local_source TEXT,
	change_json TEXT NOT NULL
);

-- The per-path outgoing version generator + tombstone high-water mark. Distinct
-- from the engine's PathSyncState baseline; a resurrected path never sorts below
-- its own tombstone (see nextVersion in storage.shared.ts).
CREATE TABLE IF NOT EXISTS fs_path_version (
	path TEXT PRIMARY KEY,
	version INTEGER NOT NULL,
	tombstone_version INTEGER NOT NULL DEFAULT 0
);
