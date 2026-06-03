import type { StandardSchemaV1 } from '@standard-schema/spec'
import type {
	ActionDef,
	ActionExample,
	ActionMeta,
	App,
	Context,
	DispatchResult,
	HandlerDef,
	Message,
	OnHandlers,
	QueryDef,
	RuntimeContext
} from './app.ts'

type MaybePromise<T> = T | Promise<T>
type Infer<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>

type Capabilities = Record<
	string,
	ReturnType<import('./capabilities/core.ts').CapabilityFactory<string, unknown, unknown>>
>

// `b.handler({...})` for state-mutating actions, `b.query({...})` for pure
// reads. The builder is bound to `State` and `Caps` by the surrounding
// `defineApp` call, so each method only needs to infer the per-action
// schema type `S` (and `R` for queries). The handler field is named the
// same in both kinds — the builder method already discriminates the kind.
export interface Builder<State, Caps extends Capabilities> {
	handler<S extends StandardSchemaV1>(def: {
		schema: S
		description?: string
		examples?: ActionExample[]
		handler: (params: Infer<S>, ctx: Context<State, Caps>) => MaybePromise<State>
	}): HandlerDef<S, State, Caps>
	query<S extends StandardSchemaV1, R>(def: {
		schema: S
		description?: string
		examples?: ActionExample[]
		handler: (params: Infer<S>, ctx: Context<State, Caps>) => MaybePromise<R>
	}): QueryDef<S, State, Caps, R>
}

interface AppSpec<
	State,
	Acts extends Record<string, ActionDef<State, Caps>>,
	Caps extends Capabilities
> {
	init: State
	capabilities?: Caps
	// Callback receives the State/Caps-bound builder. This is the standard
	// trick (tRPC, Convex) for inferring per-action schema and return types
	// in one shot while letting the surrounding defineApp call drive
	// State/Caps inference from `init`/`capabilities`.
	actions: (b: Builder<State, Caps>) => Acts
	// Declarative event subscriptions. Keys are the names declared in
	// `capabilities`; per-event handlers receive the payload type from the
	// capability contract and the same `ctx` regular actions get. The kernel
	// dispatches each event as a synthetic action `__event/<cap>.<event>`
	// — so event handlers go through the same schema-less fast-path as
	// regular dispatches and emit `app.update` on every state change.
	on?: OnHandlers<State, Caps>
}

// Synthetic action key namespace for kernel-routed capability events.
// Kept short — appears in every dispatched event and in the subscription
// index that maps channel → app subscribers.
export const EVENT_ACTION_PREFIX = '__event/'

const passthroughSchema: StandardSchemaV1 = {
	'~standard': {
		version: 1,
		vendor: 'kernel-event',
		validate: (input) => ({ value: input })
	}
}

export function defineApp<
	State,
	Acts extends Record<string, ActionDef<State, Caps>>,
	Caps extends Capabilities = Record<string, never>
>(spec: AppSpec<State, Acts, Caps>): App<State, Acts, Caps> {
	const builder: Builder<State, Caps> = {
		handler: (def) => ({ __kind: 'handler', ...def }),
		query: (def) => ({ __kind: 'query', ...def })
	}
	const acts = spec.actions(builder) as Record<string, ActionDef<State, Caps>>
	// Compose `on`-handlers into the same action table under
	// `__event/<cap>.<event>` keys. Payload validation is intentionally
	// skipped — the kernel routes only events the capability contract
	// declares, so the payload type is already pinned at compile time.
	const onSpec = (spec.on ?? {}) as Record<
		string,
		Record<string, (event: unknown, ctx: Context<State, Caps>) => MaybePromise<State>> | undefined
	>
	for (const capName in onSpec) {
		const evMap = onSpec[capName]
		if (!evMap) continue
		for (const evName in evMap) {
			const handler = evMap[evName]
			if (!handler) continue
			acts[`${EVENT_ACTION_PREFIX}${capName}.${evName}`] = {
				__kind: 'handler',
				schema: passthroughSchema,
				handler
			} as ActionDef<State, Caps>
		}
	}

	const meta = {} as Record<string, ActionMeta>
	// Keep `__event/*` entries in the sandbox-visible meta so the kernel
	// can build its subscription index. The kernel's public `actions(appId)`
	// API filters them out before exposing to agents.
	for (const type in acts) {
		const def = acts[type]
		if (!def) continue
		meta[type] = {
			kind: def.__kind,
			description: def.description,
			examples: def.examples,
			schemaHint: schemaHint(def.schema)
		}
	}
	return {
		actions: meta as Record<keyof Acts & string, ActionMeta>,
		async dispatch(message: Message, ctx: RuntimeContext<State>): Promise<DispatchResult<State>> {
			const def = acts[message.type]
			if (!def) throw new Error(`unknown action: ${message.type}`)
			const r = await def.schema['~standard'].validate(message.params)
			if (r.issues)
				throw new Error(
					`invalid params for ${message.type}: ${r.issues.map((i) => i.message).join('; ')}`
				)
			const handlerCtx = {
				...ctx,
				state: ctx.state ?? spec.init,
				capabilities: createCapabilities(spec.capabilities ?? {}, ctx as RuntimeContext, message)
			} as Context<State, Caps>
			if (def.__kind === 'query') {
				return { result: await def.handler(r.value as never, handlerCtx) }
			}
			const state = await def.handler(r.value as never, handlerCtx)
			return { state, result: state }
		}
	}
}

function createCapabilities(
	requests: Record<
		string,
		ReturnType<import('./capabilities/core.ts').CapabilityFactory<string, unknown, unknown>>
	>,
	ctx: RuntimeContext,
	message: Message
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
										actor: message.actor
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
// a message; `subscribe` receives authoritative state pushes.
export interface Transport {
	invoke(message: Message): Promise<unknown>
	subscribe(onState: (state: unknown) => void): () => void
}

// `typeof app` -> { [action]: (params) => Promise<Result> }. Per-action:
// params come from the schema's output type; handler actions resolve to
// the new State, query actions resolve to the query handler's literal
// return type (preserved via the QueryDef's R generic).
type ParamsOf<Def> =
	Def extends HandlerDef<infer S, infer _S, infer _C>
		? Infer<S>
		: Def extends QueryDef<infer S, infer _S, infer _C, infer _R>
			? Infer<S>
			: never

type ResultOf<Def, State> =
	Def extends QueryDef<infer _S, infer _ST, infer _C, infer R>
		? Awaited<R>
		: Def extends HandlerDef<infer _S, infer _ST, infer _C>
			? State
			: never

export type Client<A> =
	A extends App<infer State, infer Acts, infer _Caps>
		? {
				[K in keyof Acts & string]: (params: ParamsOf<Acts[K]>) => Promise<ResultOf<Acts[K], State>>
			}
		: never

export function createClient<A>(transport: Transport): Client<A> {
	return new Proxy({} as Client<A>, {
		get(_target, type) {
			if (typeof type !== 'string') return undefined
			return (params: unknown) => transport.invoke({ type, params })
		}
	})
}
