import { defineApp } from '@justfiles/app'
import { type AgentStatus, aiAdmin } from '@justfiles/app/capabilities/ai/admin'
import * as v from 'valibot'

// Settings is a thin façade over the `ai` capability's admin facet. State is
// only what survives a reload: which category the user is looking at, the
// projected AI connection status, a loading flag, and an inline error string.
// Transient form/busy markers stay in GUI-local React state — handlers are
// atomic, so a `busy` flag in reducer state would only be observable as null
// between dispatches.
export type Category = 'ai' | 'email'

export type SettingsState = {
	category: Category
	ai: AgentStatus | null
	loading: boolean
	error: string | null
}

export const initialState: SettingsState = {
	category: 'ai',
	ai: null,
	loading: true,
	error: null
}

const modelSchema = v.pipe(v.string(), v.minLength(1))

export const app = defineApp({
	init: initialState,
	capabilities: { ai: aiAdmin({ scopes: ['admin'] }) },
	// Pure edges drive state; `status` is the one effect, emitted as command data.
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
		selectCategory: t.on(
			v.object({ category: v.picklist(['ai', 'email']) }),
			(state, { category }) => ({ ...state, category, error: null }),
			{ description: 'Switch the selected settings category.' }
		),
		clearError: t.on(v.object({}), (state) => ({ ...state, error: null }), {
			description: 'Dismiss the current error banner.'
		})
	}),
	// signIn/selectModel/signOut are multi-step (mutate host, then reload) and the
	// caller awaits completion, so they live in procedures. Each drives the host
	// capability then re-runs `refresh` to settle fresh status.
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
		})
	})
})

export type SettingsApp = typeof app
