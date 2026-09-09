declare interface Env {
	OPENROUTER_API_KEY: string
	CODEX_PROXY_URL?: string
	CODEX_PROXY_KEY?: string
	// This host's root secret for encryption at rest. Never used as a key directly — each use
	// derives its own subkey from it (accounts: see aesGcmSecretCodec). Absent ⇒ clear.
	ENCRYPTION_KEY?: string
	FS_BLOBS?: R2Bucket
	FRIEREN_BACKEND?: 'openrouter' | 'local'
}
