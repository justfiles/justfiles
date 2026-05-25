import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Action, ActionExample, ActionMeta, App, Context, RuntimeContext } from './app.ts'

type MaybePromise<T> = T | Promise<T>
type Infer<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>

interface AppSpec<
	State,
	Schemas extends Record<string, StandardSchemaV1>,
	Caps extends Record<
		string,
		ReturnType<import('./capabilities/core.ts').CapabilityFactory<string, unknown>>
	>
> {
	init: State
	capabilities?: Caps
	handlers: {
		[Name in keyof Schemas]: {
			// Author's schema, from any Standard Schema validator (BYO).
			schema: Schemas[Name]
			description?: string
			examples?: ActionExample[]
			// params is inferred from the schema; the framework validated
			// it before this runs.
			handler: (params: Infer<Schemas[Name]>, ctx: Context<State, Caps>) => MaybePromise<State>
		}
	}
}

export function defineApp<
	State,
	Schemas extends Record<string, StandardSchemaV1>,
	Caps extends Record<
		string,
		ReturnType<import('./capabilities/core.ts').CapabilityFactory<string, unknown>>
	> = Record<string, never>
>(spec: AppSpec<State, Schemas, Caps>): App<State, Schemas, Caps> {
	const handlers = spec.handlers as unknown as Record<
		string,
		{
			schema: StandardSchemaV1
			description?: string
			examples?: ActionExample[]
			handler: (params: unknown, ctx: Context<State, Caps>) => MaybePromise<State>
		}
	>
	const schemas = {} as Record<string, StandardSchemaV1>
	const actions = {} as Record<string, ActionMeta>
	for (const type in handlers) {
		const def = handlers[type]
		if (!def) continue
		schemas[type] = def.schema
		actions[type] = {
			description: def.description,
			examples: def.examples,
			schemaHint: schemaHint(def.schema)
		}
	}
	return {
		schemas: schemas as Schemas,
		actions: actions as Record<keyof Schemas & string, ActionMeta>,
		async dispatch(action: Action, ctx: RuntimeContext<State>) {
			const def = handlers[action.type]
			if (!def) throw new Error(`unknown action: ${action.type}`)
			// Framework-owned validation: one implementation, compiled into
			// every app bundle, so it runs identically in every sandbox.
			const r = await def.schema['~standard'].validate(action.params)
			if (r.issues)
				throw new Error(
					`invalid params for ${action.type}: ${r.issues.map((i) => i.message).join('; ')}`
				)
			return def.handler(r.value, {
				...ctx,
				state: ctx.state ?? spec.init,
				capabilities: createCapabilities(spec.capabilities ?? {}, ctx as RuntimeContext, action)
			} as Context<State, Caps>)
		}
	}
}

function createCapabilities(
	requests: Record<
		string,
		ReturnType<import('./capabilities/core.ts').CapabilityFactory<string, unknown>>
	>,
	ctx: RuntimeContext,
	action: Action
): unknown {
	return new Proxy(
		{},
		{
			get(_target, localName) {
				if (typeof localName !== 'string') return undefined
				const request = requests[localName]
				if (!request) return undefined
				return new Proxy(
					{},
					{
						get(_target, method) {
							if (typeof method !== 'string') return undefined
							return async (input: unknown) => {
								if (!ctx.capabilityInvoke)
									throw capabilityError('CAPABILITY_UNAVAILABLE', request.id, method)
								try {
									return await ctx.capabilityInvoke({
										capability: request.id,
										method,
										input,
										scopes: request.scopes,
										actor: action.actor
									})
								} catch (error) {
									throw normalizeCapabilityError(error, request.id, method)
								}
							}
						}
					}
				)
			}
		}
	)
}

function capabilityError(code: string, capability: string, method: string, message = code): Error {
	return Object.assign(new Error(message), { code, capability, method })
}

function normalizeCapabilityError(error: unknown, capability: string, method: string): unknown {
	if (error instanceof Error) {
		return Object.assign(error, {
			capability: (error as { capability?: string }).capability ?? capability,
			method: (error as { method?: string }).method ?? method
		})
	}
	return capabilityError('CAPABILITY_FAILED', capability, method, String(error))
}

function schemaHint(schema: StandardSchemaV1): unknown {
	const value = schema as unknown as {
		type?: string
		expects?: string
		entries?: Record<string, unknown>
		wrapped?: unknown
		'~standard'?: { vendor?: string }
	}
	if (value.type === 'object' && value.entries) {
		return Object.fromEntries(
			Object.entries(value.entries).map(([k, v]) => [k, schemaHintValue(v)])
		)
	}
	return schemaHintValue(value)
}

function schemaHintValue(value: unknown): unknown {
	const v = value as {
		type?: string
		expects?: string
		wrapped?: unknown
		'~standard'?: { vendor?: string }
	}
	if (v.type === 'optional') return { optional: schemaHintValue(v.wrapped) }
	if (v.type) return v.type
	return { vendor: v['~standard']?.vendor ?? 'unknown', note: 'schema is not introspectable' }
}

// ----- client -----

// The host-specific wire (REST+SSE in dev, WebSocket in frieren, ...). The
// SDK owns this interface; each host owns an implementation. `invoke` sends
// an action; `subscribe` receives authoritative state pushes.
export interface Transport {
	invoke(action: Action): Promise<unknown>
	subscribe(onState: (state: unknown) => void): () => void
}

// `typeof app` -> { [action]: (params) => Promise<State> }. Inputs inferred
// from the schemas; output is uniformly State (the reducer model).
export type Client<A> =
	A extends App<infer State, infer Schemas extends Record<string, StandardSchemaV1>, infer _Caps>
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
