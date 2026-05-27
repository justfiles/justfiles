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
	actions: (b) => ({
		refresh: b.handler({
			description: 'Reload the list of integrations from the host.',
			schema: v.object({}),
			async handler(_, ctx) {
				try {
					const items = await ctx.capabilities.integrations.list({})
					return { ...ctx.state, items, loading: false, error: null }
				} catch (err) {
					return {
						...ctx.state,
						loading: false,
						error: err instanceof Error ? err.message : String(err)
					}
				}
			}
		}),
		connect: b.handler({
			description: 'Connect an account to an integration with static credentials.',
			schema: v.object({
				id: idSchema,
				accountId: accountSchema,
				credentials: credentialsSchema
			}),
			async handler({ id, accountId, credentials }, ctx) {
				try {
					await ctx.capabilities.integrations.connect({ id, accountId, credentials })
					const items = await ctx.capabilities.integrations.list({})
					return { ...ctx.state, items, error: null }
				} catch (err) {
					return {
						...ctx.state,
						error: err instanceof Error ? err.message : String(err)
					}
				}
			}
		}),
		disconnect: b.handler({
			description: 'Disconnect an account from an integration.',
			schema: v.object({ id: idSchema, accountId: accountSchema }),
			async handler({ id, accountId }, ctx) {
				try {
					await ctx.capabilities.integrations.disconnect({ id, accountId })
					const items = await ctx.capabilities.integrations.list({})
					return { ...ctx.state, items, error: null }
				} catch (err) {
					return {
						...ctx.state,
						error: err instanceof Error ? err.message : String(err)
					}
				}
			}
		}),
		clearError: b.handler({
			description: 'Dismiss the current error banner.',
			schema: v.object({}),
			handler(_, ctx) {
				return { ...ctx.state, error: null }
			}
		})
	})
})

export type SettingsApp = typeof app
