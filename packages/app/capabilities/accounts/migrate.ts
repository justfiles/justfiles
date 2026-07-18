// One-shot, idempotent migration from the legacy accounts store (one Account record
// per file, capabilities coupled in) to connections + the active-AI selection. Safe to
// run repeatedly: a no-op once connections exist, or when there are no legacy accounts
// to move. Reads through the legacy store (so it sees decoded creds) and decomposes each
// Account into a Connection (creds + reconstructed scopes) plus, for the first ai-enabled
// account, the single active-AI pointer — exactly the shape the live path now reads.

import type { Volume } from '@justfiles/fs'
import { volumeActiveAi } from './active-ai.ts'
import { type Connection, type SecretCodec, volumeConnectionStore } from './connection.ts'
import type { CapabilityId } from './contract.ts'
import { scopeFor } from './provider-caps.ts'
import { volumeAccountsStore } from './store.ts'

const SCOPED: CapabilityId[] = ['email', 'calendar']

export async function migrateAccountsToConnections(
	fs: Volume,
	opts: { secretCodec?: SecretCodec } = {}
): Promise<void> {
	const connections = volumeConnectionStore(fs, opts)
	// Already migrated (or freshly provisioned on the new model) → leave as-is.
	if ((await connections.list()).length > 0) return
	const legacy = await volumeAccountsStore(fs, opts).list()
	if (legacy.length === 0) return
	const activeAi = volumeActiveAi(fs)
	for (const account of legacy) {
		// Reconstruct granted scopes so backs() reproduces the enabled email/calendar.
		const scopes = new Set(account.scopes ?? [])
		for (const capability of SCOPED) {
			const scope = scopeFor(account.providerId, capability)
			if (scope && capability in account.enabled) scopes.add(scope)
		}
		const connection: Connection = {
			id: account.accountId,
			kind: account.providerId,
			creds: account.creds
		}
		if (scopes.size > 0) connection.scopes = [...scopes]
		if (account.lastError) connection.lastError = account.lastError
		await connections.put(connection)
		// Single-active ai: the first ai-enabled legacy account becomes the selection.
		if ('ai' in account.enabled && (await activeAi.get()) === null) {
			const model = (account.enabled.ai as { model?: string } | undefined)?.model
			await activeAi.set(
				model !== undefined
					? { connectionId: account.accountId, model }
					: { connectionId: account.accountId }
			)
		}
	}
}
