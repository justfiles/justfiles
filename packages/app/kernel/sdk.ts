import type { App, Context } from './app'

type MaybePromise<T> = T | Promise<T>

export type ActionHandler<State, Params = unknown> = (
	params: Params,
	ctx: Context<State>
) => MaybePromise<State>

export type ActionHandlers<State> = Record<string, ActionHandler<State, any>>

interface AppSpec<State, Handlers extends ActionHandlers<State> = ActionHandlers<State>> {
	init: State
	handlers: Handlers
}

export function defineApp<State, Handlers extends ActionHandlers<State>>(
	spec: AppSpec<State, Handlers>
): App<State> {
	return {
		async dispatch(action, ctx) {
			const handler = spec.handlers[action.type]
			if (!handler) throw new Error(`unknown action: ${action.type}`)
			return handler(action.params, { ...ctx, state: ctx.state ?? spec.init })
		}
	}
}
