// The minimal KV surface the audit log and the accounts store build on — the
// Durable Object storage shape. Credential persistence moved to the accounts
// store (`worker/accounts/store.ts`); this is now just the shared interface.

export interface KvStorage {
	get<T>(key: string): Promise<T | undefined>
	put<T>(key: string, value: T): Promise<void>
	delete(key: string): Promise<boolean>
	list<T>(opts?: { prefix?: string }): Promise<Map<string, T>>
}
