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
// user chose to share), and `appearance.*` the desktop's own look.

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
	// `agent_name` — the built-in default's while nothing has been written.
	name: string
	// The whole vocabulary. null only on a hand-edited or seeded file that omits it.
	gender: 'female' | 'male' | null
	// The avatar worn, as a REF: `builtin/<id>` is art in the app bundle (choosing it costs
	// no bytes and cannot drift from the app), anything else is an id under the agent's
	// `avatars/` directory — the user's own photo, or a pack they installed. null means the
	// default built-in. Opaque everywhere but the two functions that resolve it: nobody
	// parses a ref, so there is no ref type, no parser and no formatter in this contract.
	//
	// NOTE THE ABSENCE OF AN ARCHETYPE. The three natures seed the first draft and nothing
	// after it: once the prose exists, the prose is the character. The summoning leaves the
	// avatar unset so the host can use its default.
	avatar: string | null
	// The prose: the system prompt the agent wakes up with.
	body: string
	// True while this is still the built-in default — i.e. "unbound", the state that sends the
	// pane to the summoning instead of showing a form. It earns its place by saying which
	// default: an unbound agent still has a name and prose to show, and this is what tells the
	// pane they are the platform's rather than the user's. (Nothing writes the default to the
	// Volume, so the file behind an unbound soul may not exist at all — the host resolves that
	// absence to the same bytes, which is why one flag can answer for both.)
	seeded: boolean
}

// One avatar the agent could wear. AN AVATAR IS A DIRECTORY: what it covers is which files
// exist in it, which is why `files` is a listing and not a fixed set of slots.
export interface AvatarInfo {
	// What goes in the soul's `avatar:`.
	ref: string
	label: string
	// Art in the app bundle: it costs the user no storage, replicates nowhere, and is
	// read-only — `putAvatarFile` will not write into one.
	builtin: boolean
	// The state it rests in, as a data URL (the app frame's CSP allows `data:` and nothing
	// else). A complete set of six is ~25 KB, so only the resting one travels.
	preview: string
	// The file names it holds, e.g. `['resting', 'pleased']` — at most one per state, which
	// `putAvatarFile` is what guarantees. A file written through this capability IS its state;
	// one installed by other means may carry an extension (`resting.webp` from an artist's
	// pack), which says nothing — a file's format is read from its bytes. So the STEM is the
	// state, and that is how the pane finds the file a slot shows and replaces.
	files: string[]
}

// What the user chose to say about themselves. Read by the account pane, and by
// `generateSoul` (age + gender shape how the agent speaks) so the app never derives
// an age from a birth date.
export interface UserFacts {
	name: string
	// ISO `YYYY-MM-DD`, stored as a date and never as an age.
	birthDate: string
	gender: 'female' | 'male' | null
}

// A generated soul, as a PREVIEW: the pane shows it and the user keeps or discards it.
// Generation never writes — that is `writeSoul`.
export interface GeneratedSoul {
	body: string
	// An opening line to show beside the portrait, when the generator offered one.
	firstWords?: string
}

export const DOCK_MATERIAL_NAMES = ['clear', 'frosted', 'smoked', 'solid'] as const
export type DockMaterial = (typeof DOCK_MATERIAL_NAMES)[number]

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
	// WHICH BUILD THIS IS, as one opaque string the System pane prints verbatim. The HOST
	// composes it, because only the host knows what identifies one of its own builds:
	// frieren's staging redeploys from `main` on every push, so a version number there names
	// many different builds and the head commit rides along; production deploys from a tag,
	// where the version number IS the build. Nothing downstream parses it — a shape would
	// only invite a consumer to disagree with the host about what a build is called.
	//
	// CAPABILITY_UNAVAILABLE on a host that does not know its own build (the Mac app today),
	// which the pane says plainly rather than printing a version it inferred.
	'host.version'(input: Record<string, never>): Promise<string>
	// The agent's own identity, on the Volume. Served wherever the Volume is (both
	// hosts), which is what finally gives the Mac app personalization.
	'agent.readSoul'(input: Record<string, never>): Promise<AgentSoul>
	// A PATCH, like `writeProfile`: only the fields present are written. The pane edits one
	// thing at a time (a rename, a gender, the prose when you press Done), and an unfinished
	// edit of one must never ride along with a save of another. That includes `avatar`, which
	// is why there is no `wearAvatar` method: wearing one is `writeSoul({ avatar })`, an
	// ordinary field — under packs the character sheet changes the avatar too, so the old
	// "only the summoning may pass it" rule is deleted rather than restated.
	'agent.writeSoul'(input: {
		name?: string
		gender?: 'female' | 'male'
		body?: string
		avatar?: string
	}): Promise<void>
	// Every avatar this host can offer: the built-ins in the app bundle, then whatever is
	// installed on the volume.
	'agent.listAvatars'(input: Record<string, never>): Promise<AvatarInfo[]>
	// Write (or, with null bytes, delete) ONE state of an avatar, creating the avatar if this
	// is its first file. That is the whole write surface: an upload of a photo, an artist's
	// `pleased.png` and a pack being installed are the same operation, so no method here
	// enumerates states and a new one needs no deploy.
	//
	// A write CLAIMS A STATE, not a filename: `name` names the state through its stem, the
	// bytes are published AS that state (`pleased`, whatever `name`'s extension said), and any
	// other file holding the stem is removed, whatever format it was in — so `pleased.webp` and
	// `pleased.png` can never both exist and no reader has to arbitrate. One state, one path, on
	// every device: an extension would be the encoder this browser happened to have, and two
	// devices publishing the same state offline would then sync into two files nothing
	// reconciles. A delete drops the state the same way. `name` is rejected if it contains `/`
	// or starts with a dot (`.gen` is the model's, not a caller's), and `avatar` if it is not a
	// single id.
	'agent.putAvatarFile'(input: {
		avatar: string
		name: string
		bytes: Uint8Array | null
	}): Promise<void>
	'agent.readProfile'(input: Record<string, never>): Promise<UserFacts>
	// A PATCH: only the fields present are written, so the pane can save one field at a
	// time without a slower save putting back what a faster one changed.
	'agent.writeProfile'(input: {
		name?: string
		birthDate?: string
		gender?: 'female' | 'male' | null
	}): Promise<void>
	// Draft a soul from a name, a gender and who the user is. A PREVIEW: nothing is written.
	// CAPABILITY_UNAVAILABLE where no generator is wired, which the pane treats as "write it
	// yourself" rather than as an error.
	//
	// `archetype` is the summoning's seed and is optional because it is ONLY the summoning's:
	// a rewrite from the character sheet has no nature to send, since none was kept.
	//
	// `user` is the facts as the CALLER has them, and it matters because the generator does
	// not always run where the profile lives: in the browser this call is served by the
	// Durable Object, whose copy of `user.md` is a sync behind the one the user just typed
	// into. Still a date and never an age — deriving the age stays with the host, which is
	// the side that knows the user's timezone. Omitted ⇒ the host reads its own volume.
	'agent.generateSoul'(input: {
		name: string
		gender: 'female' | 'male'
		archetype?: string
		user?: { birthDate?: string; gender?: 'female' | 'male' | null }
	}): Promise<GeneratedSoul>
	// The desktop wallpaper, as the BYTES at the one path the shell watches. Two methods
	// and no taxonomy: a flat colour is bytes too (the tiny SVG the Settings app writes
	// for one), so nothing here has to know which kind is in the file — a wallpaper stays
	// what it already was, a file on the Volume that syncs like any other. Reading null
	// means unset; writing null puts the shell back on its own default.
	//
	// UNAVAILABLE on a host whose shell has no wallpaper (the Mac app today) — the pane
	// then says so, the way the Usage pane does with no meter.
	'appearance.readWallpaper'(input: Record<string, never>): Promise<Uint8Array | null>
	'appearance.writeWallpaper'(input: { bytes: Uint8Array | null }): Promise<void>
	// The dock material is one validated word at the path the shell watches. A missing or
	// unreadable value is null, which the shell and Settings both read as Smoked.
	'appearance.readDockMaterial'(input: Record<string, never>): Promise<DockMaterial | null>
	'appearance.writeDockMaterial'(input: { material: DockMaterial }): Promise<void>
}
