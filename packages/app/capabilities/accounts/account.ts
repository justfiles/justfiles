// An Account is a pure credential/identity record: one provider sign-in and the
// creds it yields — nothing about which capabilities use it. Which capability an
// account backs is DERIVED from its provider's bindings + granted scopes (see
// host.ts); the single active AI is a separate pointer (see active-ai.ts).
//
// Storage: one JSON file per account under `/private/accounts/`, keyed by a
// URL-encoded id, with `creds` the single encryptable lane via an optional
// SecretCodec (default clear — see secret-codec.ts). `creds` are opaque here: only the
// owning provider ever interprets them. `/private` never replicates, in either direction:
// a capability routes to the host that owns the credential, so no peer needs the bytes
// (see @justfiles/fs PRIVATE_PREFIXES).

import type { Volume } from '@justfiles/fs'
import { clearSecretCodec } from './secret-codec.ts'

// Transforms the `creds` lane on the way to/from disk. Default = clear (but never hands
// out a sealed value, see `clearSecretCodec`); the encrypting one is `aesGcmSecretCodec`.
// `accountId` is passed so a codec can bind a record's ciphertext to it (AES-GCM AAD) —
// one codec per host, not per record.
export interface SecretCodec {
	encode(creds: unknown, accountId: string): unknown | Promise<unknown>
	decode(raw: unknown, accountId: string): unknown | Promise<unknown>
}

export interface Account {
	id: string
	// Provider id — 'google' | 'icloud' | 'chatgpt' today; open for new providers.
	provider: string
	// `undefined` for a record whose creds could not be decoded (this host's key is gone
	// or rotated): the account still lists, so Settings can show it and the user can
	// re-connect, but every credential path treats it as unconfigured (see host.ts).
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

const DIR = '/private/accounts'
const enc = new TextEncoder()
const dec = new TextDecoder()
const pathFor = (id: string) => `${DIR}/${encodeURIComponent(id)}.json`

const DECODE_FAILED = 'credentials could not be read on this device — re-connect the account'

export function volumeAccountStore(
	fs: Volume,
	opts: { secretCodec?: SecretCodec } = {}
): AccountStore {
	const codec = opts.secretCodec ?? clearSecretCodec
	const read = async (path: string): Promise<Account | undefined> => {
		let stored: Account
		try {
			stored = JSON.parse(dec.decode(await fs.readFile(path))) as Account
		} catch {
			return undefined
		}
		// Ignore records that aren't this schema. A pre-registry install wrote
		// `{ accountId, providerId }` to this same dir; read as `Account` those
		// surface as `{ id: undefined, provider: undefined }`, which breaks callers
		// (ensureAccount can't reseed past the file; the admin facet emits an
		// undefined providerId that crashes the Settings card). Treated as absent,
		// they stay inert — overwritten by a reseed / re-connected by the user.
		if (typeof stored.id !== 'string' || typeof stored.provider !== 'string') return undefined
		try {
			return { ...stored, creds: await codec.decode(stored.creds, stored.id) }
		} catch {
			// One unreadable record must not blank the whole list — that is the
			// rotated-the-key survival path: every OTHER account keeps working, and this
			// one lists as broken (no creds + lastError) instead of vanishing silently.
			return { ...stored, creds: undefined, lastError: DECODE_FAILED }
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
			const stored = { ...account, creds: await codec.encode(account.creds, account.id) }
			await fs.writeFile(pathFor(account.id), enc.encode(JSON.stringify(stored, null, 2)))
		},
		delete: async (id) => {
			await fs.rm(pathFor(id), { force: true })
		}
	}
}
