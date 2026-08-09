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

// How a write decides. It is handed the record as it is RIGHT NOW — read inside the same
// per-account chain that will publish the result — and returns its replacement, or
// `undefined` to leave the record exactly as it is.
export type AccountChange = (
	current: Account | undefined
) => Account | undefined | Promise<Account | undefined>

export interface AccountStore {
	list(): Promise<Account[]>
	get(id: string): Promise<Account | undefined>
	// THE write — there is no bare `put`, because every mutation here is really a
	// read/decide/write and splitting those is what loses updates. The whole of `change`
	// runs with nothing else touching the SAME account, so a token refresh that lands late
	// simply sees the newer grant (or the deletion) and declines, instead of overwriting it.
	update(id: string, change: AccountChange): Promise<void>
	delete(id: string): Promise<void>
	// Seal every record still in the clear (see `hostAccounts` in host.ts for why a lazy
	// "encrypt on next write" is not enough). Idempotent: already-sealed records are
	// skipped, so it costs one read per record on a sweep with nothing to do.
	reseal(): Promise<void>
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
	// One chain per account id: a logical operation on an account runs to completion before
	// the next one on THAT account starts, and two different accounts never wait on each
	// other. `/private` is host-local and never replicates, so one store per host instance is
	// the whole coordination atom — there is nothing here for a cross-host lock to protect.
	// Keyed by id, so the map is bounded by the accounts this host holds.
	const chains = new Map<string, Promise<unknown>>()
	const serial = <T>(id: string, op: () => Promise<T>): Promise<T> => {
		// `then(op, op)` so one failed operation does not poison the chain behind it.
		const next = (chains.get(id) ?? Promise.resolve()).then(op, op)
		chains.set(
			id,
			next.catch(() => undefined)
		)
		return next
	}
	// The stored record, exactly as it sits on disk (creds still in whatever form the codec
	// wrote them). Shared by `read` and by `write`'s preserve path.
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
	// Publish a record. Always called from inside that account's chain.
	const write = async (account: Account): Promise<void> => {
		await fs.mkdir(DIR, { recursive: true })
		const path = pathFor(account.id)
		// `creds: undefined` means "this host could not read them" (see `read`), NEVER "there
		// are none" — so keep the sealed bytes already on disk instead of overwriting them.
		// Otherwise a key that is missing only for now (deployed before the secret was set,
		// a mistyped rotation) turns any ordinary write — toggling a capability off in
		// Settings — into the permanent loss of a credential the restored key could still
		// open. Every mutation funnels through here, so this is the one place to hold that line.
		//
		// `encode` throwing (a locked Keychain) throws out of here BEFORE the write, so a
		// credential this host cannot seal leaves the previous file untouched rather than
		// landing in the clear.
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
		update: (id, change) =>
			serial(id, async () => {
				const next = await change(await read(pathFor(id)))
				if (next) await write(next)
			}),
		reseal: async () => {
			let failure: unknown
			for (const path of await paths()) {
				try {
					const scanned = await readStored(path)
					if (!scanned) continue
					await serial(scanned.id, async () => {
						// Re-read INSIDE the chain: a mutation may have landed since the scan, and
						// republishing the record the scan saw would silently undo it.
						const stored = await readStored(path)
						// Nothing to seal: no record, no creds lane, or already sealed (skipping is what
						// keeps a sweep with nothing to do free of writes). An unreadable record is sealed
						// by definition, so it is skipped too — never rewritten, never lost.
						if (!stored || stored.creds === undefined || isSealed(stored.creds)) return
						await write(stored)
					})
				} catch (e) {
					// One record that cannot be sealed must not strand the rest of the sweep. The
					// first failure is rethrown at the end, so the caller's single flight clears and
					// a later account entry tries again.
					failure ??= e
				}
			}
			if (failure) throw failure
		},
		delete: (id) => serial(id, () => fs.rm(pathFor(id), { force: true }))
	}
}
