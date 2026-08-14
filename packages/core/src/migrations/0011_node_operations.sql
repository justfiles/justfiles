CREATE TABLE IF NOT EXISTS fs_node_operations (
	operation_id TEXT PRIMARY KEY,
	request_json TEXT NOT NULL,
	result_json TEXT NOT NULL
);
