ALTER TABLE memories ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_memories_dirty ON memories(dirty) WHERE dirty = 1;
