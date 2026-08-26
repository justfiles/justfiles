import type { KvStorage } from './storage.ts'

const PREFIX = 'audit/'
const DEFAULT_MAX = 1000

export interface AuditEntry {
	ts: number
	integrationId: string
	accountId: string
	command: string
	argv: string[]
	exitCode: number
}

export class AuditLog {
	private readonly max: number
	private seq = 0

	constructor(
		private readonly storage: KvStorage,
		options?: { max?: number }
	) {
		this.max = options?.max ?? DEFAULT_MAX
	}

	async append(entry: Omit<AuditEntry, 'ts'>): Promise<void> {
		const ts = Date.now()
		const id = `${ts.toString().padStart(16, '0')}-${(this.seq++).toString().padStart(6, '0')}`
		await this.storage.put(`${PREFIX}${id}`, { ...entry, ts })
		const all = await this.storage.list<AuditEntry>({ prefix: PREFIX })
		if (all.size <= this.max) return
		const overflow = all.size - this.max
		const keys = [...all.keys()].sort()
		for (let i = 0; i < overflow; i++) await this.storage.delete(keys[i])
	}

	async list(): Promise<AuditEntry[]> {
		const all = await this.storage.list<AuditEntry>({ prefix: PREFIX })
		return [...all.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v)
	}
}
