import { defineApp } from '@justfiles/app'
import {
	type AccountInfo,
	accountsAdmin,
	type CapabilityId,
	type ProviderInfo
} from '@justfiles/app/capabilities/accounts'
import { type UsageSnapshot, usage } from '@justfiles/app/capabilities/usage'
import { type UserProfile, user } from '@justfiles/app/capabilities/user'
import * as v from 'valibot'

// Settings is a thin façade over the one `accounts` admin facet: connect a
// provider, then toggle which capabilities it backs — the macOS "Internet
// Accounts" shape. ChatGPT is just an oauth provider that backs `ai`; its model
// pick rides as that capability's per-account config (no separate `ai/admin`
// facet). State is only what survives a reload: the selected category, the
// provider catalog + connected accounts, a loading flag, and an inline error.
// Transient form/busy markers stay in GUI-local React state — handlers are
// atomic, so a `busy` flag in reducer state would only be observable as null
// between dispatches.
export type Category = 'accounts' | 'usage'

export type SettingsState = {
	category: Category
	user: UserProfile | null
	providers: ProviderInfo[]
	accounts: AccountInfo[]
	usage: UsageSnapshot | null
	// Whether the host provides the `usage` capability (the Mac app doesn't yet). False hides
	// the Usage category rather than surfacing an error the user can't act on.
	usageAvailable: boolean
	// A transient usage-load failure, shown inside the Usage pane (never the global banner).
	usageError: string | null
	loading: boolean
	error: string | null
}

export const initialState: SettingsState = {
	category: 'accounts',
	user: null,
	providers: [],
	accounts: [],
	usage: null,
	usageAvailable: true,
	usageError: null,
	loading: true,
	error: null
}

const capabilitySchema = v.picklist(['email', 'calendar', 'ai'] satisfies CapabilityId[])

export const app = defineApp({
	init: initialState,
	capabilities: {
		accounts: accountsAdmin({ scopes: ['admin'] }),
		user: user({ scopes: [] }),
		usage: usage({ scopes: [] })
	},
	// Pure edges drive state; the host reads (`accounts.list*`) are the effects,
	// each emitted as command data and folded back via `fromResult`.
	update: (t) => ({
		loadProviders: t.on(
			v.object({}),
			(state) => [state, t.cmd('accounts', 'listProviders', {}).to('providersLoaded')],
			{ description: 'Load the catalog of connectable account providers.' }
		),
		providersLoaded: t.fromResult('accounts', 'listProviders', (state, r) =>
			r.ok
				? { ...state, providers: r.value, loading: false, error: null }
				: { ...state, loading: false, error: r.error.message }
		),
		loadAccounts: t.on(
			v.object({}),
			(state) => [state, t.cmd('accounts', 'listAccounts', {}).to('accountsLoaded')],
			{ description: 'Load connected accounts and their enabled capabilities.' }
		),
		accountsLoaded: t.fromResult('accounts', 'listAccounts', (state, r) =>
			r.ok ? { ...state, accounts: r.value } : { ...state, error: r.error.message }
		),
		loadUser: t.on(
			v.object({}),
			(state) => [state, t.cmd('user', 'current', {}).to('userLoaded')],
			{ description: 'Load the signed-in user for the account header.' }
		),
		userLoaded: t.fromResult('user', 'current', (state, r) =>
			r.ok ? { ...state, user: r.value } : state
		),
		loadUsage: t.on(
			v.object({}),
			(state) => [state, t.cmd('usage', 'current', {}).to('usageLoaded')],
			{ description: 'Load the metered usage + plan caps for the usage panel.' }
		),
		usageLoaded: t.fromResult('usage', 'current', (state, r) => {
			// Success restores availability (a prior host without the capability may have synced
			// usageAvailable=false into this state).
			if (r.ok) return { ...state, usage: r.value, usageAvailable: true, usageError: null }
			// A host without the `usage` capability (e.g. the Mac app) reports it unavailable — hide
			// the category, and switch off it if it was selected, so the detail pane isn't
			// stranded on a panel for a capability that will never load.
			if (r.error.message === 'CAPABILITY_UNAVAILABLE')
				return {
					...state,
					usageAvailable: false,
					category: state.category === 'usage' ? 'accounts' : state.category
				}
			return { ...state, usageError: r.error.message }
		}),
		selectCategory: t.on(
			v.object({ category: v.picklist(['accounts', 'usage']) }),
			(state, { category }) => ({ ...state, category, error: null }),
			{ description: 'Switch the selected settings category.' }
		),
		clearError: t.on(v.object({}), (state) => ({ ...state, error: null }), {
			description: 'Dismiss the current error banner.'
		})
	}),
	// The account mutations are multi-step (mutate host, then reload) and the caller
	// awaits completion, so they live in procedures. Each drives the host capability
	// then re-runs the matching load.
	procedures: (p) => ({
		connectAccount: p.procedure({
			description: 'Connect a provider account (form providers pass credentials).',
			schema: v.object({
				providerId: v.string(),
				credentials: v.optional(v.record(v.string(), v.string()))
			}),
			async run(input, app) {
				await app.invoke('accounts', 'connect', input)
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
				await app.invoke('accounts', 'setEnabled', input)
				await app.settled((await app.dispatch({ type: 'loadAccounts', params: {} })).seq, {
					timeout: 10_000
				})
			}
		}),
		disconnectAccount: p.procedure({
			description: 'Disconnect a connected account.',
			schema: v.object({ accountId: v.string() }),
			async run(input, app) {
				await app.invoke('accounts', 'disconnect', input)
				await app.settled((await app.dispatch({ type: 'loadAccounts', params: {} })).seq, {
					timeout: 10_000
				})
			}
		})
	})
})

export type SettingsApp = typeof app
