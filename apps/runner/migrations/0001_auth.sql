PRAGMA foreign_keys = ON;

CREATE TABLE oauth_flows (
	state_hash TEXT PRIMARY KEY,
	pkce_verifier TEXT NOT NULL,
	oidc_nonce TEXT NOT NULL,
	browser_hash TEXT NOT NULL,
	app_id TEXT NOT NULL,
	expires_at INTEGER NOT NULL
);

CREATE INDEX oauth_flows_expiry ON oauth_flows (expires_at);

CREATE TABLE accounts (
	user_id TEXT PRIMARY KEY,
	access_token TEXT NOT NULL,
	refresh_token TEXT NOT NULL,
	access_expires_at INTEGER NOT NULL,
	scopes TEXT NOT NULL,
	token_version INTEGER NOT NULL DEFAULT 1,
	refresh_lease_until INTEGER
);

CREATE TABLE app_grants (
	user_id TEXT NOT NULL REFERENCES accounts (user_id) ON DELETE CASCADE,
	app_id TEXT NOT NULL,
	capability_hash TEXT NOT NULL,
	resources TEXT NOT NULL,
	revoked_at INTEGER,
	PRIMARY KEY (user_id, app_id)
);

CREATE TABLE sessions (
	id_hash TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('root', 'app', 'ticket')),
	user_id TEXT NOT NULL REFERENCES accounts (user_id) ON DELETE CASCADE,
	app_id TEXT,
	request_nonce TEXT,
	expires_at INTEGER NOT NULL,
	CHECK (
		(kind = 'root' AND app_id IS NULL AND request_nonce IS NULL)
		OR (kind = 'ticket' AND app_id IS NOT NULL AND request_nonce IS NULL)
		OR (kind = 'app' AND app_id IS NOT NULL AND request_nonce IS NOT NULL)
	)
);

CREATE INDEX sessions_expiry ON sessions (expires_at);
CREATE INDEX sessions_user_app ON sessions (user_id, app_id);
