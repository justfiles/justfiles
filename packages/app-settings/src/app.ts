import { defineApp } from '@justfiles/app'
import {
	type AccountInfo,
	type AgentSoul,
	type AvatarInfo,
	type CapabilityId,
	type GeneratedSoul,
	type ProviderInfo,
	settings,
	type UsageSnapshot,
	type UserFacts,
	type UserProfile
} from '@justfiles/app/capabilities/settings'
import { fileStem, imageDataUrl } from '@justfiles/app/image-type'
import * as v from 'valibot'

// Settings is a thin façade over the one `settings` capability — the host admin
// surface, reachable only by this app (the host gates on app identity). Its
// `accounts.*` methods are the macOS "Internet Accounts" shape: connect a provider,
// then toggle which capabilities it backs. ChatGPT is just an oauth provider that
// backs `ai`; its model pick rides as that capability's per-account config. Its
// `agent.*` methods are where the companion is named, faced and given a soul — the
// flow that used to be a fake window in frieren's shell chrome, and that the Mac app
// never had at all.
//
// State is only what the VOLUME can vouch for: the selected category, the provider
// catalog + connected accounts, the agent's identity as read from the volume, a loading
// flag and an inline error. Everything transient stays in GUI-local React state — form
// fields, busy markers, and a soul being drafted (see `useDrafting`). That is not a style
// preference: this state is written to `/state/<appId>.json` and REPLICATES, so a fact
// about one window at one moment becomes a fact on every device the moment it lands here.
//
// NOTHING BINARY LIVES HERE. Reducer state is JSON-encoded to `/state/<appId>.json`
// and replicates; an avatar's bytes travel GUI↔host as a procedure's argument, and its
// picture comes back as a data URL from `listAvatars` (see `putAvatarFile`).
export type Category = 'agent' | 'account' | 'accounts' | 'appearance' | 'system'

// ── the wallpaper ─────────────────────────────────────────────────────────────
// A WALLPAPER IS ONE FILE, AND A COLOUR IS A FILE TOO. The shell paints whatever image
// sits at the wallpaper path, so a flat colour is that image: a two-line SVG. Nothing
// else in the system — not the capability, not the shell, not sync — learns that colours
// exist, and "which colour is set" is answered by reading the file back rather than by a
// second record that could disagree with it.

// Quiet, desaturated, mid-to-dark: a wallpaper's job is to sit behind the work, and white
// window chrome plus the omnibar's frosted pill both have to stay legible on it. Two
// daylight neutrals at the end for people who work in a bright room.
//
// Lower case because that is the ONE spelling a colour has on the Volume (see
// `normalizeHex`): the pane rings the chip whose hex equals what it read back out of the
// file, and a display-cased constant here would mean nothing ever matched. Display casing
// belongs to the label.
export const WALLPAPER_COLORS: { name: string; hex: string }[] = [
	{ name: 'Ink', hex: '#23262a' },
	{ name: 'Graphite', hex: '#33383d' },
	{ name: 'Slate', hex: '#3b4650' },
	{ name: 'Moss', hex: '#46534a' },
	{ name: 'Clay', hex: '#4e453f' },
	{ name: 'Plum', hex: '#413a47' },
	{ name: 'Fog', hex: '#a8aeb0' },
	{ name: 'Paper', hex: '#e7e2d9' }
]

// `#rrggbb`, lower-cased — the one spelling written to the file, so reading a colour back
// and comparing it to a preset is a string comparison and never a colour-space one.
const HEX = /^#[0-9a-f]{6}$/

export function normalizeHex(value: string): string | null {
	const hex = value.trim().toLowerCase()
	return HEX.test(hex) ? hex : null
}

// The whole encoding of a flat colour. `viewBox` with no width/height lets the shell's
// `background-size: cover` scale it to any desktop, at ~100 bytes on the Volume.
export function colorWallpaper(hex: string): Uint8Array {
	const color = normalizeHex(hex)
	if (!color) throw new Error(`not a #rrggbb colour: ${hex}`)
	return new TextEncoder().encode(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 10"><rect width="16" height="10" fill="${color}"/></svg>`
	)
}

// The colour in those bytes, or null when the wallpaper is a picture. Deliberately narrow:
// it recognises what `colorWallpaper` writes and nothing else, so a hand-made SVG someone
// dropped in Files reads as a picture (which is what it is) instead of as a colour this
// pane would then claim to own.
export function wallpaperColor(bytes: Uint8Array): string | null {
	if (bytes.length > 512) return null
	const text = new TextDecoder().decode(bytes)
	const match = /^<svg [^>]*><rect [^>]*fill="(#[0-9a-f]{6})"\/><\/svg>$/.exec(text.trim())
	return match?.[1] ?? null
}

// Which lane an account's credential lives in. An older host that hasn't deployed
// `AccountInfo.origin` yet omits it — degrade to 'cloud' rather than crash (#296).
export function originKind(account: AccountInfo): 'cloud' | 'device' {
	return account.origin?.kind ?? 'cloud'
}

// True once the connected accounts span both lanes — only then does the two-lane
// explainer in the GUI earn its place; a single-lane list needs no extra copy.
export function hasBothOrigins(accounts: AccountInfo[]): boolean {
	const kinds = new Set(accounts.map(originKind))
	return kinds.has('cloud') && kinds.has('device')
}

// An unbound agent is one still wearing the soul seeded at boot: the pane offers the
// summoning instead of a form full of someone else's defaults.
export function isBound(soul: AgentSoul | null): boolean {
	return soul !== null && !soul.seeded
}

// The default built-in, and the ONLY ref this app spells (a nature card names its own art
// too, as `builtin/<id>`): every other ref here came from the host and is passed back
// untouched. `builtin/` art lives in the app bundle, so wearing it costs no storage.
export const DEFAULT_AVATAR = 'builtin/vanilla'

// The avatar a soul is wearing, as the host described it. An absent ref means the default,
// and so does a ref naming an avatar that is not here — a pack removed, or a soul synced from
// a device that has one this one does not. Mirrors how the shell resolves it.
export function wornAvatar(soul: AgentSoul | null, avatars: AvatarInfo[]): AvatarInfo | undefined {
	const ref = soul?.avatar ?? DEFAULT_AVATAR
	return avatars.find((a) => a.ref === ref) ?? avatars.find((a) => a.ref === DEFAULT_AVATAR)
}

// The states an avatar can be in, in the order the pane shows them: whatever the BUILT-IN
// art covers. The vocabulary belongs to `@justfiles/agent/expression`, which this app cannot
// import — and every built-in is required to cover every expression, so the platform's own
// art is the list, and a new feeling appears here the moment the art does.
export function avatarStates(avatars: AvatarInfo[]): string[] {
	const states = new Set<string>()
	for (const avatar of avatars) {
		if (avatar.builtin) for (const file of avatar.files) states.add(fileStem(file))
	}
	return [...states].sort((a, b) =>
		a === 'resting' ? -1 : b === 'resting' ? 1 : a.localeCompare(b)
	)
}

// The one drift left now that a nature is chosen only at the summoning: a rename leaves
// the old name in the prose ("You are Fern…"). Report the name the prose opens with, so
// the pane can say so and offer one Rewrite — it never rewrites prose because a field
// changed.
//
// The capture runs to the first punctuation, NOT the first space: "You are Mary Jane, a
// companion…" opens with a two-word name, and taking only "Mary" would report a rename
// that never happened, forever. It must also start with a capital, or prose that opens
// "You are a companion who…" would read as a name and do the same.
export function nameInSoul(soul: AgentSoul | null): string | null {
	const match = /^You are (\p{Lu}[^,.;:!?\n—–(]{0,60})/u.exec(soul?.body.trim() ?? '')
	return match?.[1]?.trim() || null
}

export type SettingsState = {
	category: Category
	user: UserProfile | null
	providers: ProviderInfo[]
	accounts: AccountInfo[]
	usage: UsageSnapshot | null
	// Whether the host provides `host.usage` (the Mac app doesn't yet). False hides
	// the usage meters rather than surfacing an error the user can't act on.
	usageAvailable: boolean
	// A transient usage-load failure, shown inside the Account pane (never the global banner).
	usageError: string | null
	// The agent as the volume has it, and the facts the user chose to share. Null until
	// the first read lands.
	soul: AgentSoul | null
	facts: UserFacts | null
	// Bumped by every avatar write. The pictures are NOT state (see the header) and writing
	// one moves nothing else — the soul is untouched when you replace a file in the avatar you
	// already wear — so without this marker the state after a write is identical, the kernel
	// emits no update, and a pane keeps showing the face it read before. It replicates, so an
	// avatar installed on another device lands here the same way.
	avatarRevision: number
	// NO DRAFT LIVES HERE. A soul being written, the one waiting for a verdict, and whether
	// this host can write one at all are facts about ONE WINDOW at ONE MOMENT — and this
	// state replicates, so anything of that shape put here goes wrong twice over: it follows
	// the user to a device that never asked for it, and a lifecycle reset there deletes work
	// in progress here. They live in the GUI now (`useDrafting`), where a model call is what
	// it actually is: a promise belonging to whoever awaited it, which dies with them and
	// which no other device can see.
	loading: boolean
	error: string | null
}

export const initialState: SettingsState = {
	category: 'agent',
	user: null,
	providers: [],
	accounts: [],
	usage: null,
	usageAvailable: true,
	usageError: null,
	soul: null,
	facts: null,
	avatarRevision: 0,
	loading: true,
	error: null
}

const capabilitySchema = v.picklist(['email', 'calendar', 'ai'] satisfies CapabilityId[])
const genderSchema = v.picklist(['female', 'male'])

export const app = defineApp({
	init: initialState,
	capabilities: {
		// No scopes: the host gates this on first-party app identity, so a declared
		// scope would only be decoration.
		settings: settings({ scopes: [] })
	},
	// Pure edges drive state; the host reads (`accounts.list*`, `agent.read*`) are the
	// effects, each emitted as command data and folded back via `fromResult`.
	update: (t) => ({
		loadProviders: t.on(
			v.object({}),
			(state) => [state, t.cmd('settings', 'accounts.listProviders', {}).to('providersLoaded')],
			{ description: 'Load the catalog of connectable account providers.' }
		),
		providersLoaded: t.fromResult('settings', 'accounts.listProviders', (state, r) =>
			r.ok
				? { ...state, providers: r.value, loading: false, error: null }
				: { ...state, loading: false, error: r.error.message }
		),
		loadAccounts: t.on(
			v.object({}),
			(state) => [state, t.cmd('settings', 'accounts.listAccounts', {}).to('accountsLoaded')],
			{ description: 'Load connected accounts and their enabled capabilities.' }
		),
		accountsLoaded: t.fromResult('settings', 'accounts.listAccounts', (state, r) =>
			r.ok ? { ...state, accounts: r.value } : { ...state, error: r.error.message }
		),
		loadUser: t.on(
			v.object({}),
			(state) => [state, t.cmd('settings', 'host.user', {}).to('userLoaded')],
			{ description: 'Load the signed-in user for the account header.' }
		),
		userLoaded: t.fromResult('settings', 'host.user', (state, r) =>
			r.ok ? { ...state, user: r.value } : state
		),
		loadUsage: t.on(
			v.object({}),
			(state) => [state, t.cmd('settings', 'host.usage', {}).to('usageLoaded')],
			{ description: 'Load the metered usage + plan caps for the usage panel.' }
		),
		usageLoaded: t.fromResult('settings', 'host.usage', (state, r) => {
			// Success restores availability (a prior host without the capability may have synced
			// usageAvailable=false into this state).
			if (r.ok) return { ...state, usage: r.value, usageAvailable: true, usageError: null }
			// A host with no meter (e.g. the Mac app) reports it unavailable — hide the
			// meters. The pane itself stays: it carries the profile too.
			if (r.error.message === 'CAPABILITY_UNAVAILABLE') return { ...state, usageAvailable: false }
			return { ...state, usageError: r.error.message }
		}),
		loadSoul: t.on(
			v.object({}),
			(state) => [state, t.cmd('settings', 'agent.readSoul', {}).to('soulLoaded')],
			{ description: "Load the agent's name, gender and soul from the volume." }
		),
		soulLoaded: t.fromResult('settings', 'agent.readSoul', (state, r) =>
			r.ok ? { ...state, soul: r.value, error: null } : { ...state, error: r.error.message }
		),
		loadFacts: t.on(
			v.object({}),
			(state) => [state, t.cmd('settings', 'agent.readProfile', {}).to('factsLoaded')],
			{ description: 'Load the facts the user chose to share about themselves.' }
		),
		factsLoaded: t.fromResult('settings', 'agent.readProfile', (state, r) =>
			r.ok ? { ...state, facts: r.value } : { ...state, error: r.error.message }
		),
		avatarChanged: t.on(
			v.object({}),
			(state) => ({ ...state, avatarRevision: state.avatarRevision + 1 }),
			{ description: 'Note that an avatar on the volume changed, so readers re-read it.' }
		),
		selectCategory: t.on(
			v.object({
				category: v.picklist(['agent', 'account', 'accounts', 'appearance', 'system'])
			}),
			(state, { category }) => ({ ...state, category, error: null }),
			{ description: 'Switch the selected settings category.' }
		),
		clearError: t.on(v.object({}), (state) => ({ ...state, error: null }), {
			description: 'Dismiss the current error banner.'
		})
	}),
	// The mutations are multi-step (mutate host, then reload) and the caller awaits
	// completion, so they live in procedures. Each drives the host capability then
	// re-runs the matching load.
	procedures: (p) => ({
		// Drafting a soul is a READ of the model: it writes nothing and stores nothing. The
		// answer goes straight back to the window that asked (`useDrafting`), which is the
		// whole point — a promise belongs to its caller, so a window that closed mid-call
		// cannot land prose in front of anyone, and a second device never sees this one's
		// work at all.
		generateSoul: p.procedure({
			description: 'Draft a soul from a name and a gender. Writes nothing.',
			audience: 'gui',
			schema: v.object({
				name: v.string(),
				gender: genderSchema,
				// The summoning's seed, and only its: nothing records a nature, so a rewrite
				// from the character sheet has none to send.
				archetype: v.optional(v.string()),
				// Sent because the generator does not always run where the profile lives — see
				// the contract. A date, never an age: the host derives that, in the user's zone.
				user: v.optional(
					v.object({
						birthDate: v.optional(v.string()),
						gender: v.optional(v.nullable(genderSchema))
					})
				)
			}),
			run: (input, app) =>
				app.invoke('settings', 'agent.generateSoul', input) as Promise<GeneratedSoul>
		}),
		connectAccount: p.procedure({
			description: 'Connect a provider account (form providers pass credentials).',
			schema: v.object({
				providerId: v.string(),
				credentials: v.optional(v.record(v.string(), v.string()))
			}),
			async run(input, app) {
				await app.invoke('settings', 'accounts.connect', input)
				await app.settled((await app.dispatch({ type: 'loadAccounts', params: {} })).seq, {
					timeout: 10_000
				})
			}
		}),
		setAccountEnabled: p.procedure({
			description: 'Enable or disable a capability on a connected account.',
			// `config` carries per-capability settings (e.g. ai → { model }); preserved
			// across a re-enable when omitted.
			schema: v.object({
				accountId: v.string(),
				capability: capabilitySchema,
				enabled: v.boolean(),
				config: v.optional(v.unknown())
			}),
			async run(input, app) {
				await app.invoke('settings', 'accounts.setEnabled', input)
				await app.settled((await app.dispatch({ type: 'loadAccounts', params: {} })).seq, {
					timeout: 10_000
				})
			}
		}),
		disconnectAccount: p.procedure({
			description: 'Disconnect a connected account.',
			schema: v.object({ accountId: v.string() }),
			async run(input, app) {
				await app.invoke('settings', 'accounts.disconnect', input)
				await app.settled((await app.dispatch({ type: 'loadAccounts', params: {} })).seq, {
					timeout: 10_000
				})
			}
		}),
		// `avatar` is the ref the agent wears — an ordinary patch field, passed by the summoning
		// when it binds and by the picker in the character sheet. Every other save omits it and
		// the host keeps what is on the file.
		saveSoul: p.procedure({
			description: "Write the agent's name, gender and soul to the volume.",
			// A PATCH: only what is passed is written (the host merges). The sheet edits one
			// field at a time, so an unfinished soul edit must not ride along with a rename.
			schema: v.object({
				name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
				gender: v.optional(genderSchema),
				body: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
				avatar: v.optional(v.string())
			}),
			async run(input, app) {
				await app.invoke('settings', 'agent.writeSoul', input)
				await app.settled((await app.dispatch({ type: 'loadSoul', params: {} })).seq, {
					timeout: 10_000
				})
			}
		}),
		// A PATCH, field by field: the pane saves as you edit, and two saves racing must not
		// let the slower one put back the value the other just changed (the host merges).
		saveFacts: p.procedure({
			description: 'Write the facts the user chose to share about themselves.',
			schema: v.object({
				name: v.optional(v.pipe(v.string(), v.trim())),
				birthDate: v.optional(v.string()),
				gender: v.optional(v.nullable(genderSchema))
			}),
			async run(input, app) {
				await app.invoke('settings', 'agent.writeProfile', input)
				await app.settled((await app.dispatch({ type: 'loadFacts', params: {} })).seq, {
					timeout: 10_000
				})
			}
		}),
		// An avatar is a DIRECTORY, so the list is directories-with-a-preview and the write is
		// one named file in one of them. The pictures never enter reducer state (it is JSON, and
		// it replicates): they arrive as data URLs on a procedure's answer.
		listAvatars: p.procedure({
			description: 'List the avatars the agent could wear: the built-in art, then the volume.',
			audience: 'gui',
			schema: v.object({}),
			run: (_input, app) => app.invoke('settings', 'agent.listAvatars', {}) as Promise<AvatarInfo[]>
		}),
		putAvatarFile: p.procedure({
			description: 'Write one state of an avatar (null bytes deletes it).',
			audience: 'gui',
			schema: v.object({
				avatar: v.string(),
				name: v.string(),
				bytes: v.nullable(v.instance(Uint8Array))
			}),
			async run(input, app) {
				await app.invoke('settings', 'agent.putAvatarFile', input)
				// The soul is untouched by this — reloading it would fold back the same value and
				// change nothing — so the revision bump is what tells every reader (this pane, the
				// sidebar row, another device) that the art is different now.
				await app.dispatch({ type: 'avatarChanged', params: {} })
			}
		}),
		// NOR IS THE BUILD, AND FOR A SHARPER REASON THAN THE WALLPAPER'S. A version is a
		// fact about the DEVICE IN FRONT OF YOU, and this state replicates: put it here and
		// the phone that synced last would tell the laptop what the laptop is running. So the
		// System pane asks the host it is actually running on and holds the answer itself —
		// the one place where "which build" can only ever mean this one.
		readVersion: p.procedure({
			description: 'Read which build of the host this device is running.',
			audience: 'gui',
			schema: v.object({}),
			run: (_input, app) => app.invoke('settings', 'host.version', {}) as Promise<string>
		}),
		// ── the wallpaper ─────────────────────────────────────────────────────────
		// NOTHING ABOUT THE WALLPAPER IS IN STATE. The bytes are bytes (state is JSON, and it
		// replicates), and "which colour is set" is a fact about the file, so the pane reads
		// it once on mount and thereafter knows what it just wrote. A wallpaper changed on
		// another device reaches the DESKTOP through the shell's watch either way — this pane
		// is a picker, not a mirror.
		readWallpaper: p.procedure({
			description: 'Read the desktop wallpaper: its colour, or the picture as a data URL.',
			audience: 'gui',
			schema: v.object({}),
			async run(_input, app) {
				const bytes = (await app.invoke(
					'settings',
					'appearance.readWallpaper',
					{}
				)) as Uint8Array | null
				if (!bytes) return { color: null, image: null }
				const color = wallpaperColor(bytes)
				// A `data:` URL and not a `blob:` one: the app frame's CSP allows exactly that, and
				// nobody has to own a revoke (same reason avatars travel this way).
				return { color, image: color ? null : imageDataUrl(bytes) }
			}
		}),
		setWallpaperColor: p.procedure({
			description: 'Set the desktop wallpaper to a flat colour, as #rrggbb.',
			schema: v.object({ color: v.pipe(v.string(), v.regex(/^#[0-9a-fA-F]{6}$/)) }),
			run: ({ color }, app) =>
				app.invoke('settings', 'appearance.writeWallpaper', { bytes: colorWallpaper(color) })
		}),
		setWallpaperImage: p.procedure({
			description: 'Set the desktop wallpaper to an image the user chose from this device.',
			audience: 'gui',
			schema: v.object({ bytes: v.instance(Uint8Array) }),
			run: ({ bytes }, app) => app.invoke('settings', 'appearance.writeWallpaper', { bytes })
		}),
		clearWallpaper: p.procedure({
			description: "Remove the wallpaper, putting the desktop back on the shell's own default.",
			schema: v.object({}),
			run: (_input, app) => app.invoke('settings', 'appearance.writeWallpaper', { bytes: null })
		})
	})
})

export type SettingsApp = typeof app
