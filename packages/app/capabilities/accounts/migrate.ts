// One-shot, idempotent migration from the legacy accounts store (one Account record
// per file, capabilities coupled in) to connections + per-capability wiring. Safe to
// run repeatedly: it is a no-op once connections exist, or when there are no legacy
// accounts to move. Reads through the existing accounts store (so it sees decoded
// creds) and writes through the account-view, which decomposes each Account into a
// connection + wiring exactly as the live path will once it is switched over.

import type { Volume } from '@justfiles/fs'
import { accountsStoreOverConnections } from './account-view.ts'
import { volumeActiveAi } from './active-ai.ts'
import { volumeConnectionStore } from './connection.ts'
import type { SecretCodec } from './store.ts'
import { volumeAccountsStore } from './store.ts'

export async function migrateAccountsToConnections(
	fs: Volume,
	opts: { secretCodec?: SecretCodec } = {}
): Promise<void> {
	const connections = volumeConnectionStore(fs, opts)
	// Already migrated (or freshly provisioned on the new model) → leave as-is.
	if ((await connections.list()).length > 0) return
	const legacy = await volumeAccountsStore(fs, opts).list()
	if (legacy.length === 0) return
	const view = accountsStoreOverConnections(connections, volumeActiveAi(fs))
	for (const account of legacy) await view.put(account)
}
