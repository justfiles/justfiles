CREATE VIRTUAL TABLE chunks_fts USING fts5(
	chunk_id UNINDEXED,
	memory_id UNINDEXED,
	text
);
--> statement-breakpoint
CREATE TRIGGER chunks_fts_ai AFTER INSERT ON chunks
BEGIN
	INSERT INTO chunks_fts (chunk_id, memory_id, text)
	VALUES (NEW.id, NEW.memory_id, NEW.text);
END;
--> statement-breakpoint
CREATE TRIGGER chunks_fts_ad AFTER DELETE ON chunks
BEGIN
	DELETE FROM chunks_fts WHERE chunk_id = OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER chunks_fts_au AFTER UPDATE ON chunks
BEGIN
	DELETE FROM chunks_fts WHERE chunk_id = OLD.id;
	INSERT INTO chunks_fts (chunk_id, memory_id, text)
	VALUES (NEW.id, NEW.memory_id, NEW.text);
END;
