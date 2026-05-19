import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Action, App, Context } from './app'

type MaybePromise<T> = T | Promise<T>
type Infer<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>

interface AppSpec<State, Schemas extends Record<string, StandardSchemaV1>> {
	init: State
	handlers: {
		[Name in keyof Schemas]: {
			// Author's schema, from any Standard Schema validator (BYO).
			schema: Schemas[Name]
			// params is inferred from the schema; the framework validated
			// it before this runs.
			handler: (params: Infer<Schemas[Name]>, ctx: Context<State>) => MaybePromise<State>
		}
	}
}

export function defineApp<State, Schemas extends Record<string, StandardSchemaV1>>(
	spec: AppSpec<State, Schemas>
): App<State, Schemas> {
	const handlers = spec.handlers as Record<
		string,
		{
			schema: StandardSchemaV1
			handler: (params: unknown, ctx: Context<State>) => MaybePromise<State>
		}
	>
	const schemas = {} as Record<string, StandardSchemaV1>
	for (const type in handlers) schemas[type] = handlers[type].schema
	return {
		schemas: schemas as Schemas,
		async dispatch(action, ctx) {
			const def = handlers[action.type]
			if (!def) throw new Error(`unknown action: ${action.type}`)
			// Framework-owned validation: one implementation, compiled into
			// every app bundle, so it runs identically in every sandbox.
			const r = await def.schema['~standard'].validate(action.params)
			if (r.issues)
				throw new Error(
					`invalid params for ${action.type}: ${r.issues.map((i) => i.message).join('; ')}`
				)
			return def.handler(r.value, { ...ctx, state: ctx.state ?? spec.init })
		}
	}
}

// ----- client -----

// The host-specific wire (REST+SSE in dev, WebSocket in frieren, ...). The
// SDK owns this interface; each host owns an implementation. `invoke` sends
// an action; `subscribe` receives authoritative state pushes (the host is
// the single source of truth — see defineGUI).
export interface Transport {
	invoke(action: Action): Promise<unknown>
	subscribe(onState: (state: unknown) => void): () => void
}

// `typeof app` -> { [action]: (params) => Promise<State> }. Inputs inferred
// from the schemas; output is uniformly State (the reducer model).
export type Client<A> =
	A extends App<infer State, infer Schemas>
		? { [K in keyof Schemas & string]: (params: Infer<Schemas[K]>) => Promise<State> }
		: never

export function createClient<A>(transport: Transport): Client<A> {
	return new Proxy({} as Client<A>, {
		get(_target, type) {
			if (typeof type !== 'string') return undefined
			return (params: unknown) => transport.invoke({ type, params })
		}
	})
}

// ----- gui -----

type GUIState<A> = A extends App<infer State, infer _> ? State : never

interface GUISpec<A> {
	// The app's typed client is injected; the GUI never touches transport.
	mount: (
		el: HTMLElement,
		state: GUIState<A>,
		ctx: { readonly client: Client<A> }
	) => GUIInstance<GUIState<A>>
}

interface GUIInstance<State> {
	update: (state: State) => Promise<void> | void
	unmount: () => Promise<void> | void
}

// `defineGUI<typeof app>`. The host injects only the transport; defineGUI
// builds the typed client from it (so the host needs no createClient and
// the GUI needs no transport) and bridges host state pushes into the GUI's
// `update`. The GUI never reads the action return value — state flows in
// one direction, from the host through `subscribe`.
export function defineGUI<A>(spec: GUISpec<A>) {
	return {
		mount(el: HTMLElement, state: GUIState<A>, ctx: { transport: Transport }) {
			const instance = spec.mount(el, state, { client: createClient<A>(ctx.transport) })
			const unsubscribe = ctx.transport.subscribe((next) => instance.update(next as GUIState<A>))
			return {
				update: instance.update,
				async unmount() {
					unsubscribe()
					await instance.unmount()
				}
			}
		}
	}
}
