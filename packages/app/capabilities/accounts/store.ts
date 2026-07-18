// The LEGACY accounts store — retained only so the one-shot migration
// (migrate.ts) can read pre-connection data (`/system/accounts/*.json`) and
// decompose each `Account` into a Connection + the active-AI selection. The live
// path no longer reads or writes here. `Account` bundled creds, the enabled
// capability set, and OAuth scopes in one record; the new model splits that into a
// Connection (creds + scopes) with capabilities DERIVED (see provider-caps.ts).

import type { Volume } from '@justfiles/fs'
import type { Creds, SecretCodec } from './connection.ts'
import type { CapabilityId } from './contract.ts'

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
