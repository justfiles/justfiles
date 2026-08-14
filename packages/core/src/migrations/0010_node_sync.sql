-- Node-addressed sync state. Sync IDs stay separate from local filesystem inodes.
CREATE TABLE IF NOT EXISTS fs_sync_nodes (
	sync_id TEXT PRIMARY KEY,
	local_ino TEXT UNIQUE,
	parent_sync_id TEXT,
	name TEXT NOT NULL COLLATE BINARY,
	type INTEGER NOT NULL,
	revision INTEGER NOT NULL,
	deleted INTEGER NOT NULL,
	meta_json TEXT NOT NULL,
	content_hash TEXT,
	CHECK (type IN (0, 1, 2)),
	CHECK (revision >= 0),
	CHECK (deleted IN (0, 1)),
	CHECK ((deleted = 0 AND local_ino IS NOT NULL) OR (deleted = 1 AND local_ino IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fs_sync_nodes_live_name
	ON fs_sync_nodes(parent_sync_id, name)
	WHERE deleted = 0;

CREATE TABLE IF NOT EXISTS fs_node_journal (
	seq INTEGER PRIMARY KEY,
	local_source TEXT,
	operation_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fs_node_journal_mutations (
	seq INTEGER NOT NULL,
	node_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	PRIMARY KEY (seq, node_id, kind),
	FOREIGN KEY (seq) REFERENCES fs_node_journal(seq) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fs_node_journal_mutations_node
	ON fs_node_journal_mutations(node_id, seq);

CREATE TABLE IF NOT EXISTS fs_node_clock (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	head INTEGER NOT NULL
);

INSERT OR IGNORE INTO fs_node_clock(id, head) VALUES (1, 0);
