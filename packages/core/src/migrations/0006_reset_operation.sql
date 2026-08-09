-- The latest destructive reset acknowledgement. The outer Worker uses this
-- durable identity to distinguish "committed, then disconnected" from a
-- disconnect before the reset transaction committed. One latest record is
-- sufficient: callers already carry the operation id they are confirming.
ALTER TABLE fs_generation ADD COLUMN reset_operation_id TEXT;
ALTER TABLE fs_generation ADD COLUMN reset_operation_generation INTEGER;
