declare interface Env {
	OPENAI_API_KEY: string
	FS_BLOBS?: R2Bucket
	FRIEREN_BACKEND?: 'openai' | 'local'
}
