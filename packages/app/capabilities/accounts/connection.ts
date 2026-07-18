// A Connection is a pure credential/identity record: one provider sign-in and the
// creds it yields — nothing about which capabilities use it. It is the thin shared
// thing the old `Account` was really encoding ("one Google sign-in backs email +
// calendar"). Which connections back which capability lives separately in
// `wiring.ts`; the account-centric view is reassembled on top (see account-view.ts).
//
// Storage mirrors the accounts store exactly: one JSON file per connection under
// `/system/connections/`, keyed by a URL-encoded id, with `creds` the single
// encryptable lane via an optional SecretCodec (default identity — clear).

import type { Volume } from '@justfiles/fs'
import type { Creds } from './host.ts'
import type { SecretCodec } from './store.ts'

// Re-exported here as the credential store's canonical home going forward (it still
// physically lives in store.ts until the legacy store is removed).
export type { SecretCodec } from './store.ts'

export interface Connection {
	id: string
	// Provider kind — 'google' | 'icloud' | 'chatgpt' today; kept open for new providers.
	kind: string
	creds: Creds
	// OAuth grants on this connection's creds (oauth providers only); drives
	// incremental consent when a capability that needs a wider scope is enabled.
	scopes?: string[]
	lastError?: string
}

export interface ConnectionStore {
	list(): Promise<Connection[]>
	get(id: string): Promise<Connection | undefined>
	put(connection: Connection): Promise<void>
	delete(id: string): Promise<void>
}

const DIR = '/system/connections'
const enc = new TextEncoder()
const dec = new TextDecoder()
const pathFor = (id: string) => `${DIR}/${encodeURIComponent(id)}.json`

const identityCodec: SecretCodec = { encode: (creds) => creds, decode: (raw) => raw as Creds }

export function volumeConnectionStore(
	fs: Volume,
	opts: { secretCodec?: SecretCodec } = {}
): ConnectionStore {
	const codec = opts.secretCodec ?? identityCodec
	const read = async (path: string): Promise<Connection | undefined> => {
		try {
			const stored = JSON.parse(dec.decode(await fs.readFile(path))) as Connection
			return { ...stored, creds: codec.decode(stored.creds) }
		} catch {
			return undefined
		}
	}
	return {
		list: async () => {
			if (!(await fs.exists(DIR))) return []
			const out: Connection[] = []
			for (const entry of await fs.readdir(DIR)) {
				if (!entry.name.endsWith('.json')) continue
				const connection = await read(`${DIR}/${entry.name}`)
				if (connection) out.push(connection)
			}
			return out
		},
		get: async (id) => {
			const path = pathFor(id)
			return (await fs.exists(path)) ? read(path) : undefined
		},
		put: async (connection) => {
			await fs.mkdir(DIR, { recursive: true })
			const stored = { ...connection, creds: codec.encode(connection.creds) }
			await fs.writeFile(pathFor(connection.id), enc.encode(JSON.stringify(stored, null, 2)))
		},
		delete: async (id) => {
			await fs.rm(pathFor(id), { force: true })
		}
	}
}
