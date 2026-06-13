// Volume-backed AccountsStore for quay. An account is data, not code, so it rides
// the same syncable substrate as everything else (`/system`, where the agent keeps
// soul.md) — and like the connection file it replaces, it lives in the clear: the
// user's machine is the trust boundary, and *using*/*refreshing* a token is plain
// HTTPS that works anywhere once the file syncs. One JSON file per account under
// `/system/accounts/`, keyed by a URL-encoded accountId so any identity string
// (e.g. an email) is filename-safe and each write touches only its own file.

import type { Account, AccountsStore } from '@justfiles/app/capabilities/accounts/host'
import type { Volume } from '@justfiles/fs'

const DIR = '/system/accounts'
const enc = new TextEncoder()
const dec = new TextDecoder()
const pathFor = (accountId: string) => `${DIR}/${encodeURIComponent(accountId)}.json`

export function volumeAccountsStore(fs: Volume): AccountsStore {
	const read = async (path: string): Promise<Account | undefined> => {
		try {
			return JSON.parse(dec.decode(await fs.readFile(path))) as Account
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
			await fs.writeFile(pathFor(account.accountId), enc.encode(JSON.stringify(account, null, 2)))
		},
		delete: async (accountId) => {
			await fs.rm(pathFor(accountId), { force: true })
		}
	}
}
