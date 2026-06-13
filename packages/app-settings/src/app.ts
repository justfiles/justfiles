import { defineApp } from '@justfiles/app'
import {
	type AccountInfo,
	accountsAdmin,
	type CapabilityId,
	type ProviderInfo
} from '@justfiles/app/capabilities/accounts'
import { type AgentStatus, aiAdmin } from '@justfiles/app/capabilities/ai/admin'
import * as v from 'valibot'

// Settings is a thin façade over two admin facets: the `ai` capability (ChatGPT
// sign-in / model — collapses into accounts in a later slice) and the `accounts`
// capability (connect a provider, toggle which capabilities it backs — the macOS
// "Internet Accounts" shape). State is only what survives a reload: the selected
// category, the projected AI status, the provider catalog + connected accounts, a
// loading flag, and an inline error. Transient form/busy markers stay in
// GUI-local React state — handlers are atomic, so a `busy` flag in reducer state
// would only be observable as null between dispatches.
export type Category = 'ai' | 'accounts'

export type SettingsState = {
	category: Category
	ai: AgentStatus | null
	providers: ProviderInfo[]
	accounts: AccountInfo[]
	loading: boolean
	error: string | null
}

export const initialState: SettingsState = {
	category: 'ai',
	ai: null,
	providers: [],
	accounts: [],
	loading: true,
	error: null
}

const modelSchema = v.pipe(v.string(), v.minLength(1))
const capabilitySchema = v.picklist(['email', 'calendar', 'ai'] satisfies CapabilityId[])

export const app = defineApp({
	init: initialState,
	capabilities: {
		ai: aiAdmin({ scopes: ['admin'] }),
		accounts: accountsAdmin({ scopes: ['admin'] })
	},
	// Pure edges drive state; the host reads (`ai.status`, `accounts.list*`) are
	// the effects, each emitted as command data and folded back via `fromResult`.
	update: (t) => ({
		refresh: t.on(
			v.object({}),
			(state) => [{ ...state, loading: true }, t.cmd('ai', 'status', {}).to('statusLoaded')],
			{ description: 'Reload the AI agent connection status from the host.' }
		),
		statusLoaded: t.fromResult('ai', 'status', (state, r) =>
			r.ok
				? { ...state, ai: r.value, loading: false, error: null }
				: { ...state, loading: false, error: r.error.message }
		),
		loadProviders: t.on(
			v.object({}),
			(state) => [state, t.cmd('accounts', 'listProviders', {}).to('providersLoaded')],
			{ description: 'Load the catalog of connectable account providers.' }
		),
		providersLoaded: t.fromResult('accounts', 'listProviders', (state, r) =>
			r.ok ? { ...state, providers: r.value } : { ...state, error: r.error.message }
		),
		loadAccounts: t.on(
			v.object({}),
			(state) => [state, t.cmd('accounts', 'listAccounts', {}).to('accountsLoaded')],
			{ description: 'Load connected accounts and their enabled capabilities.' }
		),
		accountsLoaded: t.fromResult('accounts', 'listAccounts', (state, r) =>
			r.ok ? { ...state, accounts: r.value } : { ...state, error: r.error.message }
		),
		selectCategory: t.on(
			v.object({ category: v.picklist(['ai', 'accounts']) }),
			(state, { category }) => ({ ...state, category, error: null }),
			{ description: 'Switch the selected settings category.' }
		),
		clearError: t.on(v.object({}), (state) => ({ ...state, error: null }), {
			description: 'Dismiss the current error banner.'
		})
	}),
	// signIn/selectModel/signOut and the account mutations are multi-step (mutate
	// host, then reload) and the caller awaits completion, so they live in
	// procedures. Each drives the host capability then re-runs the matching load.
	procedures: (p) => ({
		signIn: p.procedure({
			description: 'Sign in with ChatGPT so the agent uses your subscription.',
			schema: v.object({}),
			async run(_input, app) {
				await app.invoke('ai', 'signIn', { provider: 'chatgpt' })
				await app.settled((await app.dispatch({ type: 'refresh', params: {} })).seq, {
					timeout: 10_000
				})
			}
		}),
		selectModel: p.procedure({
			description: 'Choose which model the agent uses.',
			schema: v.object({ model: modelSchema }),
			async run({ model }, app) {
				await app.invoke('ai', 'selectModel', { model })
				await app.settled((await app.dispatch({ type: 'refresh', params: {} })).seq, {
					timeout: 10_000
				})
			}
		}),
		signOut: p.procedure({
			description: 'Disconnect the ChatGPT account.',
			schema: v.object({}),
			async run(_input, app) {
				await app.invoke('ai', 'signOut', {})
				await app.settled((await app.dispatch({ type: 'refresh', params: {} })).seq, {
					timeout: 10_000
				})
			}
		}),
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
			schema: v.object({
				accountId: v.string(),
				capability: capabilitySchema,
				enabled: v.boolean()
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
