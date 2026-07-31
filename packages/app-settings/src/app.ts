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
// state would only be observable as null between dispatches. The draft token is the
// exception: a model call's progress is not otherwise visible to the GUI, and it has to
// outlive the GUI that started it.
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
	// Bumped by every avatar write. The bytes are NOT state (see the header) and writing
	// them moves nothing else — the soul is untouched — so without this marker the state
	// after a write is identical, the kernel emits no update, and a pane keeps showing
	// the face it read before. It replicates, so a photo set on another device lands here
	// the same way.
	avatarRevision: number
	// A generated soul awaiting a verdict, and WHICH FLOW asked for it; nothing is written
	// until the user keeps it. It cost a model call, so it outlives switching panes and
	// lands even while another pane is open — but not a GUI start (`guiStarted`), because
	// the draft that asked for it, the name and nature being tried, is gone by then.
	//
	// The two flows share this one slot and mean different things by it. A `rewrite` is
	// prose for the agent on the volume, so the character sheet may offer it as theirs. A
	// `summoning` is prose for an agent who does not exist yet, under a name and nature
	// that live in the ritual's own React state — the sheet cannot show that as a rewrite
	// (saving it would put a stranger's words under the current name), and if the ritual is
	// gone there is nothing left to resume it with.
	proposal: { soul: GeneratedSoul; for: DraftFor } | null
	// The draft being waited for, by token — null when none is. It is the marker the pane
	// shows "Writing…" from AND the identity that decides whose answer is whose: only a
	// result carrying this token is folded (see `draftSettled`). A boolean could not tell
	// two overlapping requests apart, and they do overlap — a GUI that restarted has no
	// idea the one before it left a model call running.
	draft: string | null
	// False once the host reports no generator (a signed-out Mac): the pane drops
	// Rewrite and lets you write the soul yourself instead of showing a dead button.
	canGenerate: boolean
	// BOTH OF THE ABOVE ARE FACTS ABOUT THIS HOST, RIGHT NOW — and this state replicates,
	// so neither may be believed once it is stale. `draft` names a request whose GUI may be
	// gone; `canGenerate` describes a host, and the Mac's "no AI here" is not the browser's.
	// `guiStarted` drops both, and a fresh account list re-probes `canGenerate` so turning
	// on a provider brings the buttons back.
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
	proposal: null,
	draft: null,
	canGenerate: true,
	loading: true,
	error: null
}

const capabilitySchema = v.picklist(['email', 'calendar', 'ai'] satisfies CapabilityId[])
const genderSchema = v.picklist(['female', 'male'])

// Which flow asked for a draft. It rides with the request and comes back with the answer,
// because the two flows keep their proposals in the same slot and must never read each
// other's (see `SettingsState['proposal']`).
export type DraftFor = 'rewrite' | 'summoning'
const draftForSchema = v.picklist(['rewrite', 'summoning'] satisfies DraftFor[])

// How a draft comes back: the token it was asked under and who asked, then either the
// soul or why it never arrived (the capability error's code, which the fold turns into a
// sentence).
const draftSettledSchema = v.object({
	token: v.string(),
	for: draftForSchema,
	soul: v.optional(v.object({ body: v.string(), firstWords: v.optional(v.string()) })),
	error: v.optional(v.string())
})

// Distinguishes one draft request from the next. Only ever compared inside this app
// instance: a request whose host is gone cannot answer at all, and a request whose GUI is
// gone answers into a state where `guiStarted` has already cleared the token.
let drafts = 0

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
			r.ok
				? // A fresh account list is also the moment to stop believing an old "no AI
					// here": enabling a provider has to bring Rewrite back without a restart.
					// If it is still unavailable the next attempt says so again.
					{ ...state, accounts: r.value, canGenerate: true }
				: { ...state, error: r.error.message }
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
		// Drafting a soul is a READ of the model: it writes nothing, and the result waits in
		// `proposal` until the user keeps it (`saveSoul`) or drops it. The two halves are
		// `commit` edges rather than a public edge + `fromResult`, because a capability
		// result carries no idea of which request it answers — and here that matters, so the
		// `generateSoul` PROCEDURE mints a token and hands it to both (see below).
		draftStarted: t.commit(v.object({ token: v.string() }), (state, { token }) => ({
			...state,
			draft: token,
			proposal: null,
			error: null
		})),
		draftSettled: t.commit(draftSettledSchema, (state, { token, for: asked, soul, error }) => {
			// NOT OURS. `draft` is set by the request that is current and cleared by
			// `guiStarted`, so a token that does not match belongs to a request something has
			// superseded: a GUI that closed mid-call, or a later request from the GUI that
			// replaced it. Both must be dropped — a resummoning's prose landing as the answer
			// to a Rewrite would sit on a bound agent's sheet, one click from being saved.
			if (token !== state.draft) return state
			if (soul) return { ...state, proposal: { soul, for: asked }, draft: null }
			// No generator here (a signed-out Mac): stop offering one, and say so once.
			if (error === 'CAPABILITY_UNAVAILABLE')
				return {
					...state,
					draft: null,
					canGenerate: false,
					error:
						'No AI is turned on here — write the soul yourself, or turn on a provider in Accounts.'
				}
			// Offline is the other reason a browser cannot draft one. Unlike no-generator it
			// is TRANSIENT, so it must not hide the buttons — but it is still a sentence,
			// not a code, and writing the soul yourself works offline: it is a file.
			if (error === 'CAPABILITY_OFFLINE')
				return {
					...state,
					draft: null,
					error: 'No connection — write the soul yourself, or try again once you are back.'
				}
			return { ...state, draft: null, error: error ?? 'The draft did not arrive.' }
		}),
		discardProposal: t.on(v.object({}), (state) => ({ ...state, proposal: null }), {
			description: 'Drop a generated soul and keep what is on the volume.'
		}),
		// Dispatched once by a GUI as it mounts, before the loads — the only moment that
		// means "this state was written by a run that is over". All three fields it resets
		// describe THIS host at THIS moment (see the state type): `draft` names a request
		// this GUI never made — left standing it shows "Writing…" forever and disables the
		// pane — a `canGenerate: false` may have been written by another device entirely,
		// and a `proposal` has lost the draft that asked for it. Clearing the token is also
		// what disowns a call still running from the last GUI: its answer no longer matches.
		guiStarted: t.on(
			v.object({}),
			(state) => ({ ...state, draft: null, canGenerate: true, proposal: null }),
			{ description: 'Drop the in-flight, no-generator and draft markers a past run left.' }
		),
		avatarChanged: t.on(
			v.object({}),
			(state) => ({ ...state, avatarRevision: state.avatarRevision + 1 }),
			{ description: 'Note that the face on the volume changed, so readers re-read it.' }
		),
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
		// A procedure only so the request and its answer can be tied together: the token it
		// mints goes into the state before the call and comes back with the result, which is
		// the one thing a `fromResult` edge cannot do (a capability result says nothing about
		// which call it answers). Nothing is written to the volume here — this is a read of
		// the model, and it settles into `proposal` for the user to keep or drop.
		generateSoul: p.procedure({
			description: 'Draft a soul from a name, a gender and a seed archetype.',
			// `for` says which flow is asking — it never reaches the capability, it rides back
			// with the answer so the panes cannot read each other's drafts.
			schema: v.object({
				name: v.string(),
				gender: genderSchema,
				archetype: v.string(),
				for: draftForSchema
			}),
			async run({ for: asked, ...input }, app) {
				const token = `draft-${++drafts}`
				await app.dispatch({ type: 'draftStarted', params: { token } })
				try {
					const soul = (await app.invoke('settings', 'agent.generateSoul', input)) as GeneratedSoul
					await app.dispatch({ type: 'draftSettled', params: { token, for: asked, soul } })
				} catch (error) {
					// A CapabilityError's message IS its code (CAPABILITY_UNAVAILABLE /
					// CAPABILITY_OFFLINE); the fold is what turns it into something to read.
					await app.dispatch({
						type: 'draftSettled',
						params: {
							token,
							for: asked,
							error: error instanceof Error ? error.message : String(error)
						}
					})
				}
			}
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
				// The soul is untouched by this — reloading it would fold back the same value
				// and change nothing — so the revision bump is what tells every reader (this
				// pane, the sidebar row, another device) that the face is a different one now.
				await app.dispatch({ type: 'avatarChanged', params: {} })
			}
		})
	})
})

export type SettingsApp = typeof app
