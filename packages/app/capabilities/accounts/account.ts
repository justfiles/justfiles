// An Account is a pure credential/identity record: one provider sign-in and the
// creds it yields — nothing about which capabilities use it. Which capability an
// account backs is DERIVED from its provider's bindings + granted scopes (see
// host.ts); the single active AI is a separate pointer (see active-ai.ts).
//
// Storage: one JSON file per account under `/private/accounts/`, keyed by a
// URL-encoded id, with `creds` the single encryptable lane via an optional
// SecretCodec (default clear — see secret-codec.ts). Records written before a key
// exists can remain plaintext until the account lane's best-effort re-seal sweep
// succeeds. `creds` are opaque here: only the owning provider ever interprets them.
// `/private` never replicates, in either direction: a capability routes to the host
// that owns the credential, so no peer needs the bytes (see @justfiles/fs
// PRIVATE_PREFIXES).

import type { Volume } from '@justfiles/fs'
import { clearSecretCodec, isSealed } from './secret-codec.ts'

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
	// re-connect, but every credential path treats it as unconfigured (see host.ts), and a
	// write preserves the sealed bytes rather than destroying them (see `put`).
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
	// Seal every record still in the clear (see `sealAccounts` in host.ts for why a lazy
	// "encrypt on next write" is not enough). Idempotent: already-sealed records are
	// skipped, so it costs one read per record on an entry with nothing to do.
	reseal(): Promise<void>
}

interface AccountMutationLane {
	mutate<T>(operation: () => Promise<T>): Promise<T>
}

const DIR = '/private/accounts'
const enc = new TextEncoder()
const dec = new TextDecoder()
const pathFor = (id: string) => `${DIR}/${encodeURIComponent(id)}.json`

const DECODE_FAILED = 'credentials could not be read on this device — re-connect the account'

export function volumeAccountStore(
	fs: Volume,
	opts: { accountLane?: AccountMutationLane; secretCodec?: SecretCodec } = {}
): AccountStore {
	const codec = opts.secretCodec ?? clearSecretCodec
	// The stored record, exactly as it sits on disk (creds still in whatever form the codec
	// wrote them). Shared by `read` and by `put`'s preserve path.
	const readStored = async (path: string): Promise<Account | undefined> => {
		try {
			return JSON.parse(dec.decode(await fs.readFile(path))) as Account
		} catch {
			return undefined
		}
	}
	const read = async (path: string): Promise<Account | undefined> => {
		const stored = await readStored(path)
		if (!stored) return undefined
		try {
			return { ...stored, creds: await codec.decode(stored.creds, stored.id) }
		} catch {
			// One unreadable record must not blank the whole list — that is the
			// rotated-the-key survival path: every OTHER account keeps working, and this
			// one lists as broken (no creds + lastError) instead of vanishing silently.
			return { ...stored, creds: undefined, lastError: DECODE_FAILED }
		}
	}
	const paths = async (): Promise<string[]> =>
		(await fs.exists(DIR))
			? (await fs.readdir(DIR))
					.filter((e) => e.name.endsWith('.json'))
					.map((e) => `${DIR}/${e.name}`)
			: []
	const mutate = <T>(operation: () => Promise<T>): Promise<T> =>
		opts.accountLane?.mutate(operation) ?? operation()
	const put = async (account: Account): Promise<void> => {
		await fs.mkdir(DIR, { recursive: true })
		const path = pathFor(account.id)
		// `creds: undefined` means "this host could not read them" (see `read`), NEVER "there
		// are none" — so keep the sealed bytes already on disk instead of overwriting them.
		// Otherwise a key that is missing only for now (deployed before the secret was set,
		// a mistyped rotation) turns any ordinary write — toggling a capability off in
		// Settings — into the permanent loss of a credential the restored key could still
		// open. Every mutation funnels through here, so this is the one place to hold that line.
		const creds =
			account.creds === undefined
				? (await readStored(path))?.creds
				: await codec.encode(account.creds, account.id)
		const stored = { ...account, creds }
		await fs.writeFile(path, enc.encode(JSON.stringify(stored, null, 2)))
	}
	return {
		list: async () => {
			const out: Account[] = []
			for (const path of await paths()) {
				const account = await read(path)
				if (account) out.push(account)
			}
			return out
		},
		get: async (id) => {
			const path = pathFor(id)
			return (await fs.exists(path)) ? read(path) : undefined
		},
		put: (account) => mutate(() => put(account)),
		reseal: () =>
			mutate(async () => {
				for (const path of await paths()) {
					const stored = await readStored(path)
					// Nothing to seal: no record, no creds lane, or already sealed (skipping is what
					// keeps a boot with nothing to do free of writes). An unreadable record is sealed by
					// definition, so it is skipped too — never rewritten, never lost.
					if (!stored) continue
					if (stored.creds === undefined || isSealed(stored.creds)) continue
					await put(stored)
				}
			}),
		delete: (id) => mutate(() => fs.rm(pathFor(id), { force: true }))
	}
}
