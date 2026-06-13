// KV-backed `AccountsStore` — the single source of truth for connected accounts.
// Creds are encrypted at rest (AES-GCM, reusing the integrations crypto helper);
// providerId / enabled-capabilities / lastError ride in the clear so `list` can
// project them without decrypting. Keyed by accountId under `accounts/`.

import type { Account, AccountsStore } from '@justfiles/app/capabilities/accounts/host'
import { decrypt, encrypt } from '../integrations/crypto.ts'
import type { KvStorage } from '../integrations/storage.ts'

const PREFIX = 'accounts/'

interface StoredAccount {
	providerId: string
	enabled: Account['enabled']
	lastError?: string
	cipher: Uint8Array
}

export function accountsStore(storage: KvStorage, encryptionKey: string): AccountsStore {
	const key = (id: string) => `${PREFIX}${id}`
	const hydrate = async (accountId: string, s: StoredAccount): Promise<Account> => ({
		accountId,
		providerId: s.providerId,
		creds: JSON.parse(await decrypt(s.cipher, encryptionKey)),
		enabled: s.enabled,
		lastError: s.lastError
	})
	return {
		list: async () => {
			const raw = await storage.list<StoredAccount>({ prefix: PREFIX })
			const out: Account[] = []
			for (const [k, s] of raw) out.push(await hydrate(k.slice(PREFIX.length), s))
			return out
		},
		get: async (accountId) => {
			const s = await storage.get<StoredAccount>(key(accountId))
			return s ? hydrate(accountId, s) : undefined
		},
		put: async (account) => {
			const cipher = await encrypt(JSON.stringify(account.creds), encryptionKey)
			await storage.put<StoredAccount>(key(account.accountId), {
				providerId: account.providerId,
				enabled: account.enabled,
				lastError: account.lastError,
				cipher
			})
		},
		delete: async (accountId) => void (await storage.delete(key(accountId)))
	}
}
