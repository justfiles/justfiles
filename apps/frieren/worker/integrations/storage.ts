import { decrypt, encrypt } from './crypto.ts'

export type StaticCreds = Record<string, string>

export interface OAuthCreds {
	accessToken: string
	refreshToken?: string
	expiresAt?: number
}

export type CredentialRecord =
	| { kind: 'static'; static: StaticCreds }
	| { kind: 'oauth'; oauth: OAuthCreds }

export interface ConnectionRecord {
	integrationId: string
	accountId: string
	creds: CredentialRecord
	enabledAt?: number
	lastError?: string
}

export interface KvStorage {
	get<T>(key: string): Promise<T | undefined>
	put<T>(key: string, value: T): Promise<void>
	delete(key: string): Promise<boolean>
	list<T>(opts?: { prefix?: string }): Promise<Map<string, T>>
}

interface StoredRecord {
	kind: 'static' | 'oauth'
	enabledAt: number
	lastError?: string
	cipher: Uint8Array
}

const PREFIX = 'connections/'

function key(integrationId: string, accountId: string): string {
	return `${PREFIX}${integrationId}/${accountId}`
}

function parseKey(k: string): { integrationId: string; accountId: string } | undefined {
	if (!k.startsWith(PREFIX)) return undefined
	const rest = k.slice(PREFIX.length)
	const slash = rest.indexOf('/')
	if (slash < 0) return undefined
	return { integrationId: rest.slice(0, slash), accountId: rest.slice(slash + 1) }
}

export class ConnectionStore {
	constructor(
		private readonly storage: KvStorage,
		private readonly encryptionKey: string
	) {}

	async put(record: ConnectionRecord): Promise<void> {
		const cipher = await encrypt(JSON.stringify(record.creds), this.encryptionKey)
		const stored: StoredRecord = {
			kind: record.creds.kind,
			enabledAt: record.enabledAt ?? Date.now(),
			lastError: record.lastError,
			cipher
		}
		await this.storage.put(key(record.integrationId, record.accountId), stored)
	}

	async get(integrationId: string, accountId: string): Promise<ConnectionRecord | undefined> {
		const stored = await this.storage.get<StoredRecord>(key(integrationId, accountId))
		if (!stored) return undefined
		return this.hydrate(integrationId, accountId, stored)
	}

	async delete(integrationId: string, accountId: string): Promise<void> {
		await this.storage.delete(key(integrationId, accountId))
	}

	async list(): Promise<ConnectionRecord[]> {
		const raw = await this.storage.list<StoredRecord>({ prefix: PREFIX })
		const out: ConnectionRecord[] = []
		for (const [k, stored] of raw) {
			const parsed = parseKey(k)
			if (!parsed) continue
			out.push(await this.hydrate(parsed.integrationId, parsed.accountId, stored))
		}
		return out
	}

	async listFor(integrationId: string): Promise<ConnectionRecord[]> {
		const all = await this.list()
		return all.filter((c) => c.integrationId === integrationId)
	}

	async setLastError(
		integrationId: string,
		accountId: string,
		message: string | undefined
	): Promise<void> {
		const stored = await this.storage.get<StoredRecord>(key(integrationId, accountId))
		if (!stored) return
		const next: StoredRecord = { ...stored, lastError: message }
		await this.storage.put(key(integrationId, accountId), next)
	}

	private async hydrate(
		integrationId: string,
		accountId: string,
		stored: StoredRecord
	): Promise<ConnectionRecord> {
		const creds = JSON.parse(await decrypt(stored.cipher, this.encryptionKey)) as CredentialRecord
		return {
			integrationId,
			accountId,
			creds,
			enabledAt: stored.enabledAt,
			lastError: stored.lastError
		}
	}
}
