DROP INDEX IF EXISTS idx_fs_sync_nodes_live_name;

ALTER TABLE fs_sync_nodes RENAME TO fs_sync_nodes_old;

CREATE TABLE fs_sync_nodes (
	sync_id TEXT PRIMARY KEY,
	local_ino TEXT UNIQUE,
	parent_sync_id TEXT,
	name TEXT NOT NULL COLLATE BINARY,
	type INTEGER NOT NULL,
	revision INTEGER NOT NULL,
	deleted INTEGER NOT NULL,
	meta_json TEXT NOT NULL,
	content_hash TEXT,
	materialization TEXT NOT NULL DEFAULT 'attached',
	CHECK (type IN (0, 1, 2)),
	CHECK (revision >= 0),
	CHECK (deleted IN (0, 1)),
	CHECK (materialization IN ('attached', 'hidden', 'blocked', 'absent')),
	CHECK ((deleted = 0) OR (local_ino IS NULL))
);

INSERT INTO fs_sync_nodes(
	sync_id, local_ino, parent_sync_id, name, type, revision, deleted, meta_json, content_hash,
	materialization
)
SELECT
	sync_id, local_ino, parent_sync_id, name, type, revision, deleted, meta_json, content_hash,
	CASE WHEN local_ino IS NULL THEN 'absent' ELSE 'attached' END
FROM fs_sync_nodes_old;

DROP TABLE fs_sync_nodes_old;

CREATE UNIQUE INDEX idx_fs_sync_nodes_live_name
	ON fs_sync_nodes(parent_sync_id, name)
	WHERE deleted = 0;
