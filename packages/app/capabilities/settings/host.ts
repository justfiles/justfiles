// How a host serves `settings`. This file composes what already exists — the accounts
// admin impl, a usage thunk, an identity thunk — and implements no admin logic itself.
// Two things make it unlike the other capability hosts:
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

import { CapabilityError } from '../error.ts'
import type { Capabilities, Capability } from '../types.ts'
import type { AccountsAdmin, SettingsCapability, UsageSnapshot, UserProfile } from './contract.ts'

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
	return {
		invoke: async (call) => {
			if (!SETTINGS_ALLOWLIST.has(call.appId)) throw unavailable(call.method)
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
