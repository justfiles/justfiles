// The canonical AccountsStore — INTERNAL to @justfiles/app, never re-exported.
// An account is data, not code, so it rides the Volume, the one syncable substrate
// present on every platform (the same place the agent keeps `/system/soul.md`).
// Each native host used to re-derive this over its own storage (quay over the
// Volume, frieren over KV); now they all share this one. One JSON file per account
// under `/system/accounts/`, keyed by a URL-encoded accountId so any identity
// string (e.g. an email) is filename-safe and each write touches only its own file.
//
// `creds` is the single encryptable lane: a `secretCodec` transforms just that
// field on the way to/from disk. The default is identity — accounts ride in the
// clear, the Volume being the trust boundary — and encryption returns later as a
// codec swap, not a store rewrite.

import type { Volume } from '@justfiles/fs'
import type { CapabilityId } from './contract.ts'
import type { Creds } from './host.ts'

// A connected provider plus the capabilities the user has enabled on it — the
// persisted unit. `creds` is the single encryptable lane (see `secretCodec`);
// `enabled` keys are the enabled capabilities, each mapped to its per-capability
// config (e.g. ai → { model }); `scopes` records OAuth grants. These shapes live
// here, in the internal store, so they never cross the package boundary.
export interface Account {
	accountId: string
	providerId: string
	creds: Creds
	enabled: Partial<Record<CapabilityId, unknown>>
	// OAuth scopes granted to this account's creds (oauth providers only). Rides in
	// the clear like `enabled`; drives incremental consent in `setEnabled`.
	scopes?: string[]
	lastError?: string
}

export interface AccountsStore {
	list(): Promise<Account[]>
	get(accountId: string): Promise<Account | undefined>
	put(account: Account): Promise<void>
	delete(accountId: string): Promise<void>
}

const DIR = '/system/accounts'
const enc = new TextEncoder()
const dec = new TextDecoder()
const pathFor = (accountId: string) => `${DIR}/${encodeURIComponent(accountId)}.json`

// Transforms the `creds` lane on the way to/from disk. Default = identity (clear).
export interface SecretCodec {
	encode(creds: Creds): unknown
	decode(raw: unknown): Creds
}

const identityCodec: SecretCodec = {
	encode: (creds) => creds,
	decode: (raw) => raw as Creds
}

export function volumeAccountsStore(
	fs: Volume,
	opts: { secretCodec?: SecretCodec } = {}
): AccountsStore {
	const codec = opts.secretCodec ?? identityCodec
	const read = async (path: string): Promise<Account | undefined> => {
		try {
			const stored = JSON.parse(dec.decode(await fs.readFile(path))) as Account
			return { ...stored, creds: codec.decode(stored.creds) }
		} catch {
			return undefined
		}
	}
	return {
		list: async () => {
			if (!(await fs.exists(DIR))) return []
			const out: Account[] = []
			for (const entry of await fs.readdir(DIR)) {
				if (!entry.name.endsWith('.json')) continue
				const account = await read(`${DIR}/${entry.name}`)
				if (account) out.push(account)
			}
			return out
		},
		get: async (accountId) => {
			const path = pathFor(accountId)
			return (await fs.exists(path)) ? read(path) : undefined
		},
		put: async (account) => {
			await fs.mkdir(DIR, { recursive: true })
			const stored = { ...account, creds: codec.encode(account.creds) }
			await fs.writeFile(pathFor(account.accountId), enc.encode(JSON.stringify(stored, null, 2)))
		},
		delete: async (accountId) => {
			await fs.rm(pathFor(accountId), { force: true })
		}
	}
}
