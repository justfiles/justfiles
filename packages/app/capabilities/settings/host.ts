// How a host serves `settings`. This file composes what already exists — the accounts
// admin impl, a usage thunk, an identity thunk — and implements no admin logic itself.
// Three things make it unlike the other capability hosts:
//
//  • THE GATE IS APP IDENTITY. One allowlist check covers every method, reported as
//    UNAVAILABLE (not DENIED) so a non-first-party app cannot tell the capability
//    exists. The list lives here, once, for every host — the contract's rule 2 (single
//    consumer, forever) is what keeps it a constant.
//  • A METHOD IS SERVED WHERE ITS DEP IS. Each method runs locally when its dep is
//    wired, is delegated to `remote` if the host gave one, and is UNAVAILABLE if it did
//    not. That one rule covers all three hosts: the frieren browser half wires `user`
//    and delegates `accounts.*`/`host.usage` to the DO (credentials live under
//    `/private/**`, which never replicates), the DO wires both and delegates nothing,
//    and the Mac daemon wires `accounts` only — so its Usage pane hides itself.
//  • THE READ UNION: `listAccounts` CONCATENATES, `listProviders` DEDUPES.
//    A signed-in device can hold accounts in BOTH lanes at once — some connected
//    directly on it, some owned by the cloud and reached through `remote` (#305) —
//    and the user expects to see all of them in one Settings list, each tagged by
//    `AccountInfo.origin` (#296). So when `accounts` AND `remote` are both
//    configured, `listAccounts` fans out to both and concatenates (accounts never
//    collide across hosts). `listProviders` fans out too, but DEDUPES by id
//    (this side wins on a collision, e.g. both may offer 'google') — a remote-only
//    entry still has to reach here, because a merged account's `ProviderInfo` (in
//    particular `builtin`) has to be resolvable on THIS side too, or Settings can't
//    tell a remote built-in account from an ordinary one and renders a Disconnect
//    button for it (see the mutation-routing note below — that button is live).
//  • MUTATING BY OWNER. The merged list can show an account this side does NOT
//    own, so mutating one (`setEnabled`/`disconnect`) first checks whether the
//    local store actually has it — local if so, `remote` if not (D1: administer an
//    account where it lives). `connect` needs no such check: it creates a NEW
//    account, always on this side. With only one lane configured, every check above
//    is a no-op — unchanged from before any of this existed.

import { CapabilityError } from '../error.ts'
import type { Capabilities, Capability } from '../types.ts'
import type {
	AccountsAdmin,
	ProviderInfo,
	SettingsCapability,
	UsageSnapshot,
	UserProfile
} from './contract.ts'

// The one identity gate. Not a scope: a declared scope would hand the host admin
// surface to any sideloaded app that declares `settings`.
export const SETTINGS_ALLOWLIST = new Set(['app.justfiles.frieren.settings'])

// Where the host reads usage from (the frieren DO's per-user meter + quota) and who
// is signed in (Clerk in the browser; the native account later). Thunks, so every
// call reflects the CURRENT counters/session — a sign-in is picked up on the next call.
export type GetUsage = () => UsageSnapshot | Promise<UsageSnapshot>
export type GetUser = () => UserProfile | null | Promise<UserProfile | null>

export interface SettingsHostDeps {
	accounts?: AccountsAdmin
	usage?: GetUsage
	user?: GetUser
	// Where a method this host cannot serve goes (the browser half → the DO).
	remote?: Capabilities
}

// The methods this host serves. A missing key is the "not here" signal the
// dispatcher routes on, so the split is derived from the deps, never restated.
type Served = { [K in keyof SettingsCapability]?: SettingsCapability[K] }

export function settingsHost(deps: SettingsHostDeps): Capability {
	const { accounts, usage, user, remote } = deps
	const served: Served = {
		...(accounts && {
			'accounts.listProviders': (i) => accounts.listProviders(i),
			'accounts.listAccounts': (i) => accounts.listAccounts(i),
			'accounts.connect': (i) => accounts.connect(i),
			'accounts.setEnabled': (i) => accounts.setEnabled(i),
			'accounts.disconnect': (i) => accounts.disconnect(i)
		}),
		...(usage && { 'host.usage': async () => usage() }),
		// Always local, even with no dep: "no one is signed in" is an answer, not an
		// error, and identity lives where the session does.
		'host.user': async () => (await user?.()) ?? null
	}
	const unavailable = (method: string) =>
		new CapabilityError('CAPABILITY_UNAVAILABLE', 'settings', method)
	// Does THIS host's own store have `accountId`? The merged list can show an account
	// this side doesn't own, so a mutation checks before running — see the file header.
	const ownsLocally = async (accountId: string): Promise<boolean> =>
		!!accounts && (await accounts.listAccounts({})).some((a) => a.accountId === accountId)
	return {
		invoke: async (call) => {
			if (!SETTINGS_ALLOWLIST.has(call.appId)) throw unavailable(call.method)
			// The read union (see the file header): both lanes configured ⇒ both queried.
			// One lane configured ⇒ that lane alone, unchanged from before this existed
			// (the DO has no `remote`; the browser has no `accounts`).
			if (call.method === 'accounts.listAccounts' && accounts && remote) {
				const [local, cloud] = await Promise.all([
					accounts.listAccounts(...(call.args as [Record<string, never>])),
					remote.invoke(call) as Promise<unknown[]>
				])
				return [...local, ...cloud]
			}
			if (call.method === 'accounts.listProviders' && accounts && remote) {
				const [local, cloud] = await Promise.all([
					accounts.listProviders(...(call.args as [Record<string, never>])),
					remote.invoke(call) as Promise<ProviderInfo[]>
				])
				const ids = new Set(local.map((p) => p.id))
				return [...local, ...cloud.filter((p) => !ids.has(p.id))]
			}
			// Mutating an EXISTING account by id must reach whichever side actually owns
			// it: `setEnabled`/`disconnect` route local only when the local store has the
			// account, remote otherwise — a no-op (both configured) when it's neither.
			if (
				(call.method === 'accounts.setEnabled' || call.method === 'accounts.disconnect') &&
				accounts &&
				remote
			) {
				const { accountId } = call.args[0] as { accountId: string }
				if (!(await ownsLocally(accountId))) return remote.invoke(call)
			}
			const method = served[call.method as keyof SettingsCapability]
			// The frame rides on unchanged, so the far end gates on the same appId.
			if (!method) {
				if (remote) return remote.invoke(call)
				throw unavailable(call.method)
			}
			return (method as (...args: readonly unknown[]) => Promise<unknown>)(...call.args)
		},
		// No streams: nothing on the admin surface is push-shaped.
		subscribe: async (call) => {
			throw unavailable(call.method)
		}
	}
}
