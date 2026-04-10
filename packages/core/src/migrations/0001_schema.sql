CREATE TABLE IF NOT EXISTS fs_inodes (
	ino TEXT PRIMARY KEY,
	type INTEGER NOT NULL,
	mode INTEGER NOT NULL,
	size INTEGER NOT NULL,
	mtime_ns INTEGER NOT NULL,
	ctime_ns INTEGER NOT NULL,
	content_hash TEXT,
	symlink_target TEXT,
	mime_type TEXT,
	storage_kind INTEGER NOT NULL DEFAULT 0,
	CHECK (type IN (0, 1, 2)),
	CHECK (storage_kind IN (0, 1, 2)),
	CHECK (size >= 0),
	CHECK (type = 0 OR content_hash IS NULL),
	CHECK (
		(type = 2 AND symlink_target IS NOT NULL) OR
		(type != 2 AND symlink_target IS NULL)
	)
);

CREATE INDEX IF NOT EXISTS idx_fs_inodes_content_hash ON fs_inodes(content_hash);

CREATE TABLE IF NOT EXISTS fs_dirents (
	dir_ino TEXT NOT NULL,
	name TEXT NOT NULL COLLATE BINARY,
	ino TEXT NOT NULL,
	type INTEGER NOT NULL,
	PRIMARY KEY (dir_ino, name),
	CHECK (type IN (0, 1, 2)),
	CHECK (name <> ''),
	CHECK (instr(name, '/') = 0),
	CHECK (name <> '.'),
	CHECK (name <> '..'),
	FOREIGN KEY (dir_ino) REFERENCES fs_inodes(ino) ON DELETE RESTRICT,
	FOREIGN KEY (ino) REFERENCES fs_inodes(ino) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_fs_dirents_ino ON fs_dirents(ino);

CREATE TABLE IF NOT EXISTS fs_xattrs (
	ino TEXT NOT NULL,
	name TEXT NOT NULL,
	value BLOB NOT NULL,
	PRIMARY KEY (ino, name),
	CHECK (name <> ''),
	FOREIGN KEY (ino) REFERENCES fs_inodes(ino) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fs_xattrs_ino ON fs_xattrs(ino);

CREATE TABLE IF NOT EXISTS fs_contents (
	content_hash TEXT PRIMARY KEY,
	storage_kind INTEGER NOT NULL,
	size INTEGER NOT NULL,
	inline_bytes BLOB,
	inline_text TEXT,
	r2_key TEXT,
	mime_type TEXT,
	text_encoding TEXT,
	created_at_ns INTEGER NOT NULL,
	CHECK (storage_kind IN (1, 2)),
	CHECK (
		(storage_kind = 1 AND inline_bytes IS NOT NULL AND r2_key IS NULL) OR
		(storage_kind = 2 AND inline_bytes IS NULL AND r2_key IS NOT NULL)
	),
	CHECK (size >= 0)
);

CREATE VIRTUAL TABLE IF NOT EXISTS fs_content_fts USING fts5(
	content_hash UNINDEXED,
	text
);

CREATE TABLE IF NOT EXISTS fs_updates (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	tx_id TEXT NOT NULL,
	op_index INTEGER NOT NULL,
	at_ns INTEGER NOT NULL,
	op_kind TEXT NOT NULL,
	ino TEXT,
	dir_ino TEXT,
	name TEXT,
	entry_ino TEXT,
	entry_type INTEGER,
	meta_json TEXT,
	xattrs_json TEXT,
	content_changed INTEGER NOT NULL DEFAULT 0,
	source TEXT
);

CREATE INDEX IF NOT EXISTS idx_fs_updates_tx_id ON fs_updates(tx_id, op_index);
CREATE INDEX IF NOT EXISTS idx_fs_updates_source_seq ON fs_updates(source, seq);

CREATE TABLE IF NOT EXISTS fs_state (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
