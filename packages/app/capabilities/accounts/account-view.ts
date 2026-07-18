// The account-centric view over connections + the active-AI selection. It presents the
// legacy `AccountsStore` shape — an Account = a connection plus the capabilities enabled
// on it — so the current accounts host/broker keep working unchanged while storage moves
// to connections. Enablement is DERIVED, not stored as a separate table:
//   • email/calendar  — from the connection's granted scopes (see provider-caps.ts)
//   • ai              — from the single-active selection (see active-ai.ts)
// This read/reconcile logic is what the admin capability's façade grows out of once the
// broker is gone.

import type { ActiveAiStore } from './active-ai.ts'
import type { Connection, ConnectionStore } from './connection.ts'
import type { CapabilityId } from './contract.ts'
import { backs, scopeFor } from './provider-caps.ts'
import type { Account, AccountsStore } from './store.ts'

// Scope-gated capabilities whose enablement lives in the connection's granted scopes.
const SCOPED: CapabilityId[] = ['email', 'calendar']

// Reassemble one Account from its connection + the active-AI selection.
function toAccount(
	connection: Connection,
	activeAi: { connectionId: string; model?: string } | null
): Account {
	const enabled: Partial<Record<CapabilityId, unknown>> = {}
	if (backs(connection, 'email')) enabled.email = {}
	if (backs(connection, 'calendar')) enabled.calendar = {}
	if (activeAi?.connectionId === connection.id)
		enabled.ai = activeAi.model !== undefined ? { model: activeAi.model } : {}
	const account: Account = {
		accountId: connection.id,
		providerId: connection.kind,
		creds: connection.creds,
		enabled
	}
	if (connection.scopes) account.scopes = connection.scopes
	if (connection.lastError) account.lastError = connection.lastError
	return account
}

// email/calendar enablement is carried by the connection's granted scopes: fold the
// account's enabled set back into scopes — add the scope for each enabled scoped
// capability, drop it for a disabled one, and keep any other granted scopes.
function reconcileScopes(account: Account): string[] | undefined {
	const scopes = new Set(account.scopes ?? [])
	for (const capability of SCOPED) {
		const scope = scopeFor(account.providerId, capability)
		if (!scope) continue
		if (capability in account.enabled) scopes.add(scope)
		else scopes.delete(scope)
	}
	return scopes.size > 0 ? [...scopes] : undefined
}

export function accountsStoreOverConnections(
	connections: ConnectionStore,
	activeAi: ActiveAiStore
): AccountsStore {
	return {
		list: async () => {
			const [all, selection] = await Promise.all([connections.list(), activeAi.get()])
			return all.map((connection) => toAccount(connection, selection))
		},
		get: async (accountId) => {
			const connection = await connections.get(accountId)
			return connection ? toAccount(connection, await activeAi.get()) : undefined
		},
		put: async (account) => {
			const connection: Connection = {
				id: account.accountId,
				kind: account.providerId,
				creds: account.creds
			}
			const scopes = reconcileScopes(account)
			if (scopes) connection.scopes = scopes
			if (account.lastError) connection.lastError = account.lastError
			await connections.put(connection)
			// Single-active ai selection: point it here when enabled, clear it when this
			// connection was the active AI and ai is now off.
			if ('ai' in account.enabled) {
				const model = (account.enabled.ai as { model?: string } | undefined)?.model
				await activeAi.set(
					model !== undefined
						? { connectionId: account.accountId, model }
						: { connectionId: account.accountId }
				)
			} else if ((await activeAi.get())?.connectionId === account.accountId) {
				await activeAi.set(null)
			}
		},
		delete: async (accountId) => {
			await connections.delete(accountId)
			if ((await activeAi.get())?.connectionId === accountId) await activeAi.set(null)
		}
	}
}
