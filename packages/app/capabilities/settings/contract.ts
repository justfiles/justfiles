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
// connected provider accounts, `host.*` reads what only the host knows, `agent.*`
// edits the one companion's identity on the Volume (soul, face, and the facts the
// user chose to share).

import type { AccountsAdmin } from '../accounts/contract.ts'

// The account projections the UI renders, re-exported so Settings imports one
// surface. They belong to the accounts model; this capability only carries them.
export type {
	AccountInfo,
	AccountOrigin,
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

// ── agent.* ───────────────────────────────────────────────────────────────

// The one companion's identity, as the Settings pane edits it: parsed, never raw
// markdown. The host owns the file format (`@justfiles/agent/defaults` owns the paths),
// so no consumer re-implements the frontmatter parse — there were three copies of it
// before this capability existed.
export interface AgentSoul {
	// `agent_name`. Empty while the seeded default is in place and nothing was written.
	name: string
	// The whole vocabulary. null only on a hand-edited or seeded file that omits it.
	gender: 'female' | 'male' | null
	// The seed the first draft was written from, recorded at the summoning and NOT a
	// setting afterwards (see `writeSoul`). null on a soul that predates it.
	archetype: string | null
	// Which built-in face set is worn. null means "the photo on the volume" (avatar.png).
	avatarVariant: string | null
	// The prose: the system prompt the agent wakes up with.
	body: string
	// True while this is the untouched default seeded at boot — i.e. "unbound", the state
	// that sends the pane to the summoning instead of showing a form.
	seeded: boolean
}

// What the user chose to say about themselves. Read by the account pane, and by
// `generateSoul` (age + gender shape how the agent speaks) so the app never derives
// an age from a birth date.
export interface UserFacts {
	name: string
	// ISO `YYYY-MM-DD`, stored as a date and never as an age.
	birthDate: string
	gender: 'female' | 'male' | null
	seeded: boolean
}

// A generated soul, as a PREVIEW: the pane shows it and the user keeps or discards it.
// Generation never writes — that is `writeSoul`.
export interface GeneratedSoul {
	body: string
	// An opening line to show beside the portrait, when the generator offered one.
	firstWords?: string
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
	// The agent's own identity, on the Volume. Served wherever the Volume is (both
	// hosts), which is what finally gives the Mac app personalization.
	'agent.readSoul'(input: Record<string, never>): Promise<AgentSoul>
	// Writes name/gender/prose and clears the seeded flag. `archetype` is accepted ONLY
	// by the summoning (first bind, or "summon again") and is otherwise preserved as
	// written: a returning user has prose, and prose — not a seed word — is the character.
	// Passing an archetype also re-points the built-in face to that archetype's art;
	// an uploaded photo still wins (see `writeAvatar`).
	// A PATCH, like `writeProfile`: only the fields present are written. The pane edits one
	// thing at a time (a rename, a gender, the prose when you press Done), and an unfinished
	// edit of one must never ride along with a save of another.
	'agent.writeSoul'(input: {
		name?: string
		gender?: 'female' | 'male'
		body?: string
		archetype?: string
	}): Promise<void>
	// The chosen face, as bytes, or null while the built-in art is worn.
	'agent.readAvatar'(input: Record<string, never>): Promise<Uint8Array | null>
	// Store a photo, or pass null to drop back to the built-in art. Null DELETES the
	// file: stale bytes would keep winning over the variant otherwise.
	'agent.writeAvatar'(input: { bytes: Uint8Array | null }): Promise<void>
	'agent.readProfile'(input: Record<string, never>): Promise<UserFacts>
	// A PATCH: only the fields present are written, so the pane can save one field at a
	// time without a slower save putting back what a faster one changed.
	'agent.writeProfile'(input: {
		name?: string
		birthDate?: string
		gender?: 'female' | 'male' | null
	}): Promise<void>
	// Draft a soul from a name, a gender and a seed archetype — plus who the user is. A
	// PREVIEW: nothing is written. CAPABILITY_UNAVAILABLE where no generator is wired,
	// which the pane treats as "write it yourself" rather than as an error.
	//
	// `user` is the facts as the CALLER has them, and it matters because the generator does
	// not always run where the profile lives: in the browser this call is served by the
	// Durable Object, whose copy of `user.md` is a sync behind the one the user just typed
	// into. Still a date and never an age — deriving the age stays with the host, which is
	// the side that knows the user's timezone. Omitted ⇒ the host reads its own volume.
	'agent.generateSoul'(input: {
		name: string
		gender: 'female' | 'male'
		archetype: string
		user?: { birthDate?: string; gender?: 'female' | 'male' | null }
	}): Promise<GeneratedSoul>
}
