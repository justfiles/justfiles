import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { App, Context } from './app'

type MaybePromise<T> = T | Promise<T>
type Infer<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>

interface AppSpec<State, Schemas extends Record<string, StandardSchemaV1>> {
	init: State
	handlers: {
		[Name in keyof Schemas]: {
			// Author's schema, from any Standard Schema validator (BYO).
			schema: Schemas[Name]
			// params is inferred from the schema; the kernel has already
			// validated it before this runs.
			handler: (params: Infer<Schemas[Name]>, ctx: Context<State>) => MaybePromise<State>
		}
	}
}

export function defineApp<State, Schemas extends Record<string, StandardSchemaV1>>(
	spec: AppSpec<State, Schemas>
): App<State> {
	const handlers = spec.handlers as Record<
		string,
		{
			schema: StandardSchemaV1
			handler: (params: unknown, ctx: Context<State>) => MaybePromise<State>
		}
	>
	const schemas: Record<string, StandardSchemaV1> = {}
	for (const type in handlers) schemas[type] = handlers[type].schema
	return {
		schemas,
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
