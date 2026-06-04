import { defineApp } from '@justfiles/app'
import { type IntegrationDescriptor, integrations } from '@justfiles/app/capabilities/integrations'
import * as v from 'valibot'

// Settings is a thin façade over the host's integrations registry. State is
// what survives a reload: the projected descriptors, the loading flag, and
// an inline error string. Transient form values and per-card busy markers
// stay in GUI-local React state — handlers are atomic, so a `busy` flag in
// reducer state would only ever be observable as null between dispatches.
export type SettingsState = {
	items: IntegrationDescriptor[]
	loading: boolean
	error: string | null
}

export const initialState: SettingsState = {
	items: [],
	loading: true,
	error: null
}

const idSchema = v.pipe(v.string(), v.minLength(1))
const accountSchema = v.pipe(v.string(), v.minLength(1))
const credentialsSchema = v.record(v.string(), v.string())

export const app = defineApp({
	init: initialState,
	capabilities: { integrations: integrations({ scopes: [] }) },
	// Pure edges drive state; `list` is the one effect, emitted as command data.
	update: (t) => ({
		refresh: t.on(
			v.object({}),
			(state) => [{ ...state, loading: true }, t.cmd('integrations', 'list', {}, 'listed')],
			{ description: 'Reload the list of integrations from the host.' }
		),
		listed: t.fromResult('integrations', 'list', (state, r) =>
			r.ok
				? { ...state, items: r.value, loading: false, error: null }
				: { ...state, loading: false, error: r.error.message }
		),
		clearError: t.on(v.object({}), (state) => ({ ...state, error: null }), {
			description: 'Dismiss the current error banner.'
		})
	}),
	// connect/disconnect are multi-step (mutate, then reload) and the caller
	// awaits completion, so they live in procedures, not the pure core. Each
	// drives the host capability then re-runs `refresh` to settle fresh items.
	procedures: (p) => ({
		connect: p.procedure({
			description: 'Connect an account to an integration with static credentials.',
			schema: v.object({ id: idSchema, accountId: accountSchema, credentials: credentialsSchema }),
			async run({ id, accountId, credentials }, app) {
				await app.invoke('integrations', 'connect', { id, accountId, credentials })
				await app.settled((await app.dispatch({ type: 'refresh', params: {} })).seq, {
					timeout: 10_000
				})
			}
		}),
		disconnect: p.procedure({
			description: 'Disconnect an account from an integration.',
			schema: v.object({ id: idSchema, accountId: accountSchema }),
			async run({ id, accountId }, app) {
				await app.invoke('integrations', 'disconnect', { id, accountId })
				await app.settled((await app.dispatch({ type: 'refresh', params: {} })).seq, {
					timeout: 10_000
				})
			}
		})
	})
})

export type SettingsApp = typeof app
