// An Account is a pure credential/identity record: one provider sign-in and the
// creds it yields — nothing about which capabilities use it. Which capability an
// account backs is DERIVED from its provider's bindings + granted scopes (see
// host.ts); the single active AI is a separate pointer (see active-ai.ts).
//
// Storage: one JSON file per account under `/system/accounts/`, keyed by a
// URL-encoded id, with `creds` the single encryptable lane via an optional
// SecretCodec (default identity — clear). `creds` are opaque here: only the owning
// provider ever interprets them.

import type { Volume } from '@justfiles/fs'

// Transforms the `creds` lane on the way to/from disk. Default = identity (clear).
export interface SecretCodec {
	encode(creds: unknown): unknown
	decode(raw: unknown): unknown
}

export interface Account {
	id: string
	// Provider id — 'google' | 'icloud' | 'chatgpt' today; open for new providers.
	provider: string
	creds: unknown
	// OAuth grants on this account's creds (oauth providers only); drives
	// incremental consent when a capability that needs a wider scope is enabled.
	scopes?: string[]
	lastError?: string
}

export interface AccountStore {
	list(): Promise<Account[]>
	get(id: string): Promise<Account | undefined>
	put(account: Account): Promise<void>
	delete(id: string): Promise<void>
}

const DIR = '/system/accounts'
const enc = new TextEncoder()
const dec = new TextDecoder()
const pathFor = (id: string) => `${DIR}/${encodeURIComponent(id)}.json`

const identityCodec: SecretCodec = { encode: (creds) => creds, decode: (raw) => raw }

export function volumeAccountStore(
	fs: Volume,
	opts: { secretCodec?: SecretCodec } = {}
): AccountStore {
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
		get: async (id) => {
			const path = pathFor(id)
			return (await fs.exists(path)) ? read(path) : undefined
		},
		put: async (account) => {
			await fs.mkdir(DIR, { recursive: true })
			const stored = { ...account, creds: codec.encode(account.creds) }
			await fs.writeFile(pathFor(account.id), enc.encode(JSON.stringify(stored, null, 2)))
		},
		delete: async (id) => {
			await fs.rm(pathFor(id), { force: true })
		}
	}
}
