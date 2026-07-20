declare interface Env {
	OPENROUTER_API_KEY: string
	FS_BLOBS?: R2Bucket
	FRIEREN_BACKEND?: 'openrouter' | 'local'
}
