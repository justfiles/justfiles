import type { Static, TSchema } from 'typebox'

import type { App, Context } from './app'

type MaybePromise<T> = T | Promise<T>

interface AppSpec<State, Schemas extends Record<string, TSchema>> {
	init: State
	handlers: {
		[Name in keyof Schemas]: {
			schema: Schemas[Name]
			handler: (params: Static<Schemas[Name]>, ctx: Context<State>) => MaybePromise<State>
		}
	}
}

export function defineApp<State, Schemas extends Record<string, TSchema>>(
	spec: AppSpec<State, Schemas>
): App<State> {
	const handlers = spec.handlers as Record<
		string,
		{ handler: (params: unknown, ctx: Context<State>) => MaybePromise<State> }
	>
	return {
		async dispatch(action, ctx) {
			const def = handlers[action.type]
			if (!def) throw new Error(`unknown action: ${action.type}`)
			return def.handler(action.params, { ...ctx, state: ctx.state ?? spec.init })
		}
	}
}

// TODO: for later, empty for now
interface GUIContext<State> {
	readonly state: State
}

interface GUISpec<State> {
	mount: (el: HTMLElement, state: State, ctx: GUIContext<State>) => GUIInstance<State>
}

interface GUIInstance<State> {
	update: (state: State) => Promise<void> | void
	unmount: () => Promise<void> | void
}

export function defineGUI<State>(spec: GUISpec<State>) {
	return spec
}
