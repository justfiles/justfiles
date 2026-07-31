import { defineApp } from '@justfiles/app'
import {
	type AccountInfo,
	type AgentSoul,
	type CapabilityId,
	type GeneratedSoul,
	type ProviderInfo,
	settings,
	type UsageSnapshot,
	type UserFacts,
	type UserProfile
} from '@justfiles/app/capabilities/settings'
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
// State is only what survives a reload: the selected category, the provider catalog +
// connected accounts, the agent's identity as read from the volume, a generated soul
// awaiting a verdict, a loading flag, and an inline error. Transient form/busy markers
// stay in GUI-local React state — handlers are atomic, so a `busy` flag in reducer
// state would only be observable as null between dispatches. `generating` is the
// exception: a command's completion is not otherwise visible to the GUI.
//
// NOTHING BINARY LIVES HERE. Reducer state is JSON-encoded to `/state/<appId>.json`
// and replicates; the avatar's bytes travel GUI↔host as a procedure's argument and
// return value instead (see `readAvatar`/`saveAvatar`).
export type Category = 'agent' | 'account' | 'accounts'

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

// The one drift left now that a nature is chosen only at the summoning: a rename
// leaves the old name in the prose ("You are Fern…"). Report it so the pane can say so
// and offer one Rewrite — never rewrite prose because a field changed.
export function nameInSoul(soul: AgentSoul | null): string | null {
	const match = /^You are ([\p{L}][\p{L}\d'’-]*)/u.exec(soul?.body.trim() ?? '')
	return match?.[1] ?? null
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
	// A generated soul awaiting a verdict. It cost a model call, so it outlives a reload;
	// nothing is written until the user keeps it.
	proposal: GeneratedSoul | null
	// A command is in flight. The GUI cannot otherwise see a command settle, and the
	// summoning needs to show that something is happening.
	generating: boolean
	// False once the host reports no generator (a signed-out Mac): the pane drops
	// Rewrite and lets you write the soul yourself instead of showing a dead button.
	canGenerate: boolean
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
	proposal: null,
	generating: false,
	canGenerate: true,
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
		// Drafting a soul is a READ of the model: it writes nothing, and the result waits
		// in `proposal` until the user keeps it (`saveSoul`) or drops it.
		generateSoul: t.on(
			v.object({ name: v.string(), gender: genderSchema, archetype: v.string() }),
			(state, params) => [
				{ ...state, generating: true, proposal: null, error: null },
				t.cmd('settings', 'agent.generateSoul', params).to('soulGenerated')
			],
			{ description: 'Draft a soul from a name, a gender and a seed archetype.' }
		),
		soulGenerated: t.fromResult('settings', 'agent.generateSoul', (state, r) => {
			if (r.ok) return { ...state, proposal: r.value, generating: false }
			// No generator here (a signed-out Mac): stop offering one, and say so once.
			if (r.error.message === 'CAPABILITY_UNAVAILABLE')
				return {
					...state,
					generating: false,
					canGenerate: false,
					error:
						'No AI is turned on here — write the soul yourself, or turn on a provider in Accounts.'
				}
			return { ...state, generating: false, error: r.error.message }
		}),
		discardProposal: t.on(v.object({}), (state) => ({ ...state, proposal: null }), {
			description: 'Drop a generated soul and keep what is on the volume.'
		}),
		selectCategory: t.on(
			v.object({ category: v.picklist(['agent', 'account', 'accounts']) }),
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
		// `archetype` is passed by the summoning ONLY — the first bind and "summon again".
		// Omitting it is what makes a returning user's save unable to contradict the nature
		// the soul was written from (the host preserves it; see the capability's contract).
		saveSoul: p.procedure({
			description: "Write the agent's name, gender and soul to the volume.",
			schema: v.object({
				name: v.pipe(v.string(), v.trim(), v.minLength(1)),
				gender: genderSchema,
				body: v.pipe(v.string(), v.trim(), v.minLength(1)),
				archetype: v.optional(v.string())
			}),
			async run(input, app) {
				await app.invoke('settings', 'agent.writeSoul', input)
				await app.dispatch({ type: 'discardProposal', params: {} })
				await app.settled((await app.dispatch({ type: 'loadSoul', params: {} })).seq, {
					timeout: 10_000
				})
			}
		}),
		saveFacts: p.procedure({
			description: 'Write the facts the user chose to share about themselves.',
			schema: v.object({
				name: v.pipe(v.string(), v.trim()),
				birthDate: v.string(),
				gender: v.nullable(genderSchema)
			}),
			async run(input, app) {
				await app.invoke('settings', 'agent.writeProfile', input)
				await app.settled((await app.dispatch({ type: 'loadFacts', params: {} })).seq, {
					timeout: 10_000
				})
			}
		}),
		// The avatar's bytes never enter reducer state (it is JSON, and it replicates):
		// they ride in and out as procedure data, and the GUI turns them into a blob URL.
		readAvatar: p.procedure({
			description: 'Read the uploaded avatar, or null while the built-in art is worn.',
			audience: 'gui',
			schema: v.object({}),
			run: (_input, app) =>
				app.invoke('settings', 'agent.readAvatar', {}) as Promise<Uint8Array | null>
		}),
		saveAvatar: p.procedure({
			description: 'Store a photo as the agent’s face, or null to wear the built-in art.',
			audience: 'gui',
			schema: v.object({ bytes: v.nullable(v.instance(Uint8Array)) }),
			async run(input, app) {
				await app.invoke('settings', 'agent.writeAvatar', input)
				// The soul is unchanged, but the shell watches BOTH files — re-read so a
				// pane showing "your photo" vs "the art" cannot lag the volume.
				await app.settled((await app.dispatch({ type: 'loadSoul', params: {} })).seq, {
					timeout: 10_000
				})
			}
		})
	})
})

export type SettingsApp = typeof app
