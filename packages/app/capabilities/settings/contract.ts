// The host admin surface, as ONE capability: the back-channel the first-party Settings
// app uses to administer the machine. It replaces the former `accounts` admin facet plus
// the `usage` and `user` capabilities — three public contracts for a single consumer.
// Two rules keep a grab-bag safe (the `devkit` argument verbatim):
//
//  1. ENFORCE BY APP ID IN THE HOST, NEVER BY SCOPE. A declared scope would hand the
//     keys to any sideloaded app that declares `settings`; the gate is app identity
//     (see `SETTINGS_ALLOWLIST` in ./host.ts).
//  2. SINGLE CONSUMER, FOREVER. If a second app ever needs a slice, that slice
//     GRADUATES into its own capability; the allowlist does not grow.
//
// Methods are area-prefixed so the bucket stays legible: `accounts.*` administers
// connected provider accounts, `host.*` reads what only the host knows.

import type { AccountsAdmin } from '../accounts/contract.ts'

// The account projections the UI renders, re-exported so Settings imports one
// surface. They belong to the accounts model; this capability only carries them.
export type {
	AccountInfo,
	AccountsAdmin,
	CapabilityId,
	CredentialField,
	CredentialsSchema,
	ProviderInfo
} from '../accounts/contract.ts'

// ── host.usage ────────────────────────────────────────────────────────────

// One metered resource: what's used, the cap (null = unlimited), and derived headroom.
// `used`/`limit`/`remaining` are in the resource's natural unit (USD for AI, bytes for
// storage). `fraction` is used/limit (0 when unlimited) — for a progress bar.
export interface UsageResource {
	used: number
	limit: number | null
	remaining: number | null
	exceeded: boolean
	fraction: number
}

// An AI usage window with its reset instant. `resetsAt` (ms epoch) is when the window's
// usage clears; null means an idle burst window (nothing spent, so no active window to
// reset).
export interface UsageWindow extends UsageResource {
	resetsAt: number | null
}

// Host-agnostic by design: the frieren host maps its server-side usage + quota into this
// shape; another host can implement it differently, or not at all.
export interface UsageSnapshot {
	// The plan the caps come from (e.g. 'free', 'pro').
	tier: string
	// AI cost (USD) in the short rolling "burst" window — anti-burst throttle.
	aiBurst: UsageWindow
	// AI cost (USD) in the fixed weekly window — the real budget ceiling.
	aiWeekly: UsageWindow
	// Logical (deduped) storage bytes — a point-in-time gauge.
	storage: UsageResource
	// Extra AI detail for display (not capped): tokens + provider requests this weekly window.
	aiTokens: number
	aiRequests: number
}

// ── host.user ─────────────────────────────────────────────────────────────

// The person using the OS — distinct from a connected third-party account.
export interface UserProfile {
	// Stable account identifier (Clerk user id in frieren; the native account later).
	id: string
	name?: string
	avatarUrl?: string
}

export interface SettingsCapability {
	// Connected provider accounts: the macOS "Internet Accounts" shape — connect a
	// provider once, then toggle which capabilities that account backs.
	'accounts.listProviders': AccountsAdmin['listProviders']
	'accounts.listAccounts': AccountsAdmin['listAccounts']
	'accounts.connect': AccountsAdmin['connect']
	'accounts.setEnabled': AccountsAdmin['setEnabled']
	'accounts.disconnect': AccountsAdmin['disconnect']
	// The signed-in user's metered usage against their plan. CAPABILITY_UNAVAILABLE on
	// a host with no meter (the Mac app) — the pane hides itself.
	'host.usage'(input: Record<string, never>): Promise<UsageSnapshot>
	// The signed-in user, or null when no one is signed in (the Mac app before native
	// auth; a signed-out web session). Null is a valid state, never an error.
	'host.user'(input: Record<string, never>): Promise<UserProfile | null>
}
