CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT
);

CREATE TABLE IF NOT EXISTS memories (
	id TEXT PRIMARY KEY NOT NULL,
	scope TEXT NOT NULL,
	title TEXT,
	content_hash TEXT NOT NULL,
	path TEXT NOT NULL,
	source TEXT,
	active INTEGER NOT NULL DEFAULT 1,
	expires_at TEXT,
	last_retrieved_at TEXT,
	retrieval_count INTEGER DEFAULT 0,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_tags (
	memory_id TEXT NOT NULL REFERENCES memories(id),
	tag TEXT NOT NULL,
	PRIMARY KEY (memory_id, tag)
);

CREATE TABLE IF NOT EXISTS chunks (
	id TEXT PRIMARY KEY NOT NULL,
	memory_id TEXT NOT NULL REFERENCES memories(id),
	seq INTEGER NOT NULL,
	start_line INTEGER,
	end_line INTEGER,
	text TEXT NOT NULL,
	token_count INTEGER,
	hash TEXT NOT NULL,
	embedding_model TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunk_vectors (
	chunk_id TEXT NOT NULL PRIMARY KEY REFERENCES chunks(id),
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	dims INTEGER NOT NULL,
	embedding BLOB NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS embeddings_cache (
	hash TEXT NOT NULL,
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	dims INTEGER NOT NULL,
	embedding BLOB NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY(hash, provider, model)
);

CREATE TABLE IF NOT EXISTS events (
	id TEXT PRIMARY KEY,
	memory_id TEXT REFERENCES memories(id),
	event_type TEXT NOT NULL,
	actor_type TEXT,
	actor_name TEXT,
	at TEXT NOT NULL,
	payload_json TEXT
);

CREATE TABLE IF NOT EXISTS memory_links (
	from_id TEXT NOT NULL REFERENCES memories(id),
	to_id TEXT NOT NULL REFERENCES memories(id),
	rel_type TEXT NOT NULL,
	actor_type TEXT,
	actor_name TEXT,
	reason TEXT,
	created_at TEXT NOT NULL,
	PRIMARY KEY(from_id, to_id, rel_type)
);

CREATE TABLE IF NOT EXISTS proposals (
	id TEXT PRIMARY KEY,
	memory_id TEXT NOT NULL REFERENCES memories(id),
	proposal_type TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	reason TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	actor_type TEXT,
	actor_name TEXT,
	created_at TEXT NOT NULL,
	resolved_at TEXT,
	resolved_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_scope_active ON memories(scope, active);
CREATE INDEX IF NOT EXISTS idx_memories_path ON memories(scope, path);
CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(content_hash);
CREATE INDEX IF NOT EXISTS idx_chunks_memory ON chunks(memory_id);
CREATE INDEX IF NOT EXISTS idx_chunks_memory_seq ON chunks(memory_id, seq);
CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag);
CREATE INDEX IF NOT EXISTS idx_memory_links_from ON memory_links(from_id);
CREATE INDEX IF NOT EXISTS idx_memory_links_to ON memory_links(to_id);
CREATE INDEX IF NOT EXISTS idx_proposals_memory ON proposals(memory_id, status);
CREATE INDEX IF NOT EXISTS idx_proposals_pending ON proposals(status) WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_memories_scope_path ON memories(scope, path) WHERE active = 1;

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
	chunk_id UNINDEXED,
	memory_id UNINDEXED,
	text
);

CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON chunks
BEGIN
	INSERT INTO chunks_fts (chunk_id, memory_id, text) VALUES (NEW.id, NEW.memory_id, NEW.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks
BEGIN
	DELETE FROM chunks_fts WHERE chunk_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_au AFTER UPDATE ON chunks
BEGIN
	DELETE FROM chunks_fts WHERE chunk_id = OLD.id;
	INSERT INTO chunks_fts (chunk_id, memory_id, text) VALUES (NEW.id, NEW.memory_id, NEW.text);
END;
