declare interface Env {
	OPENROUTER_API_KEY: string
	// Seals account credentials at rest (see accounts secret-codec). Absent ⇒ clear.
	ACCOUNTS_KEY?: string
	FS_BLOBS?: R2Bucket
	FRIEREN_BACKEND?: 'openrouter' | 'local'
}
