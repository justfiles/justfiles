import type { StandardSchemaV1 } from '@standard-schema/spec'
import type {
	ActionDef,
	ActionExample,
	ActionMeta,
	App,
	AppHandle,
	Context,
	DispatchResult,
	Edge,
	Edges,
	HandlerDef,
	Message,
	OnHandlers,
	ProcedureAudience,
	ProcedureDef,
	ProcedureDefs,
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

// `p.procedure({...})` — the imperative facade (Part C). `run` receives the
// validated params and an AppHandle bound to State. Bound to State/Caps by the
// surrounding `defineApp`, so each call only infers the per-procedure schema S
// and return type R (preserved for `Client<A>`).
export interface Procedures<State, Caps extends Capabilities> {
	procedure<S extends StandardSchemaV1, R>(def: {
		audience?: ProcedureAudience
		description?: string
		schema: S
		run: (params: Infer<S>, app: AppHandle<State, Caps>) => MaybePromise<R>
	}): ProcedureDef<S, State, Caps, R>
}

interface AppSpec<
	State,
	Acts extends Record<string, ActionDef<State, Caps>>,
	Caps extends Capabilities,
	Procs extends ProcedureDefs<State, Caps>
> {
	init: State
	capabilities?: Caps
	// Callback receives the State/Caps-bound builder. This is the standard
	// trick (tRPC, Convex) for inferring per-action schema and return types
	// in one shot while letting the surrounding defineApp call drive
	// State/Caps inference from `init`/`capabilities`. Optional so a pure-core
	// app may define only `update`.
	actions?: (b: Builder<State, Caps>) => Acts
	// Pure-core edge table (Part A). One `update` map of pure edges
	// `(state, payload) → state | [state, command]`. Public edges declare a
	// schema via `t.on`; internal edges receive a typed capability result via
	// `t.fromResult`. Additive — an app may use `actions`, `update`, or both
	// during migration; edges take precedence in dispatch.
	update?: (t: Edges<State, Caps>) => Record<string, Edge<State>>
	// Declarative event subscriptions. Keys are the names declared in
	// `capabilities`; per-event handlers receive the payload type from the
	// capability contract and the same `ctx` regular actions get. The kernel
	// dispatches each event as a synthetic action `__event/<cap>.<event>`
	// — so event handlers go through the same schema-less fast-path as
	// regular dispatches and emit `app.update` on every state change.
	on?: OnHandlers<State, Caps>
	// Procedures (Part C) — the optional imperative facade. Same builder trick
	// as `actions`: the callback receives the State/Caps-bound `p` so each
	// procedure's schema and return type infer per call. Apps that need none
	// omit it entirely.
	procedures?: (p: Procedures<State, Caps>) => Procs
}

// Synthetic action key namespace for kernel-routed capability events.
// Kept short — appears in every dispatched event and in the subscription
// index that maps channel → app subscribers.
export const EVENT_ACTION_PREFIX = '__event/'

// Capability results re-enter the reducer as `__cmd/<edge>` messages (the
// kernel runs the command, then dispatches the result; Part B). The prefix
// keeps internal `fromResult` edges off the public, schema-validated path:
// a public `on` edge matches only its plain name, a result edge only `__cmd/`.
// Exported so the kernel's command executor can address result edges by name.
export const CMD_RESULT_PREFIX = '__cmd/'

function resolveEdge<State>(
	edges: Record<string, Edge<State>>,
	type: string
): Edge<State> | undefined {
	if (type.startsWith(CMD_RESULT_PREFIX)) {
		const edge = edges[type.slice(CMD_RESULT_PREFIX.length)]
		return edge?.__edge === 'result' ? edge : undefined
	}
	const edge = edges[type]
	return edge?.__edge === 'on' ? edge : undefined
}

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
	Caps extends Capabilities = Record<string, never>,
	Procs extends ProcedureDefs<State, Caps> = Record<string, never>
>(spec: AppSpec<State, Acts, Caps, Procs>): App<State, Acts, Caps, Procs> {
	const builder: Builder<State, Caps> = {
		handler: (def) => ({ __kind: 'handler', ...def }),
		query: (def) => ({ __kind: 'query', ...def })
	}
	const acts = (spec.actions?.(builder) ?? {}) as Record<string, ActionDef<State, Caps>>
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

	// Pure-core edges (Part A). The builder erases payload types into the
	// stored `Edge<State>`; `cmd` returns command data. `fromResult`'s
	// capability/method are compile-time only (they type the payload) — the
	// kernel routes results by edge name, so the runtime ignores them here.
	const edgeBuilder: Edges<State, Caps> = {
		on: (schema, transition) => ({ __edge: 'on', schema, transition }),
		fromResult: (_capability, _method, transition) => ({ __edge: 'result', transition }),
		cmd: (capability, method, input, to) => ({ kind: 'capability', capability, method, input, to })
	}
	const edges = (spec.update?.(edgeBuilder) ?? {}) as Record<string, Edge<State>>

	// Declared capabilities surfaced as runtime data so the kernel can attach
	// trusted scopes server-side (Part B). The factory already resolved each
	// to { id, scopes }; we just expose the local-name → { id, scopes } map.
	const caps = (spec.capabilities ?? {}) as Capabilities
	const declaredCapabilities: Record<string, { id: string; scopes: readonly string[] }> = {}
	for (const name in caps) {
		const cap = caps[name]
		if (cap) declaredCapabilities[name] = { id: cap.id, scopes: cap.scopes }
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
	// Public edges (those with a schema) join the action surface as handlers;
	// internal `fromResult` edges are routed by the kernel and stay off the
	// public, agent-visible list.
	for (const type in edges) {
		const edge = edges[type]
		if (!edge || edge.__edge !== 'on' || !edge.schema) continue
		meta[type] = { kind: 'handler', schemaHint: schemaHint(edge.schema) }
	}

	// Procedures (Part C). The builder stamps the default audience; their meta
	// joins the same `actions` map with `kind: 'procedure'`, so the kernel can
	// route a dispatch to `runProcedure` by name and the agent can list them.
	const procBuilder: Procedures<State, Caps> = {
		procedure: (def) => ({ __kind: 'procedure', audience: def.audience ?? 'both', ...def })
	}
	const procs = (spec.procedures?.(procBuilder) ?? {}) as ProcedureDefs<State, Caps>
	for (const name in procs) {
		const def = procs[name]
		if (!def) continue
		meta[name] = {
			kind: 'procedure',
			audience: def.audience,
			description: def.description,
			schemaHint: schemaHint(def.schema)
		}
	}
	return {
		actions: meta,
		capabilities: declaredCapabilities,
		async runProcedure(name, params, app): Promise<unknown> {
			const def = procs[name]
			if (!def) throw new Error(`unknown procedure: ${name}`)
			const schema = def.schema as StandardSchemaV1
			const r = await schema['~standard'].validate(params)
			if (r.issues)
				throw new Error(`invalid params for ${name}: ${r.issues.map((i) => i.message).join('; ')}`)
			// The kernel can't default `state` to `init` (init lives here, in the
			// bundle), so fold it in — matching the reducer's `ctx.state ?? init`.
			const handle = app.state == null ? { ...app, state: spec.init } : app
			return def.run(r.value as never, handle)
		},
		async dispatch(message: Message, ctx: RuntimeContext<State>): Promise<DispatchResult<State>> {
			// Pure-core edges take precedence over legacy actions. A public
			// edge validates its schema; an internal `__cmd/<edge>` result is
			// passed through. The transition is synchronous and effect-free —
			// it returns the next state and, optionally, a command to run.
			const edge = resolveEdge(edges, message.type)
			if (edge) {
				let payload: unknown = message.params
				if (edge.schema) {
					const r = await edge.schema['~standard'].validate(message.params)
					if (r.issues)
						throw new Error(
							`invalid params for ${message.type}: ${r.issues.map((i) => i.message).join('; ')}`
						)
					payload = r.value
				}
				const out = edge.transition(ctx.state ?? spec.init, payload)
				const [state, command] = Array.isArray(out) ? out : [out]
				return { state, command, result: state }
			}
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

// Procedures are addressed by the same client/transport as actions; their
// params come from the schema and the result is the `run` return type.
type ProcParamsOf<Def> =
	Def extends ProcedureDef<infer S, infer _ST, infer _C, infer _R> ? Infer<S> : never
type ProcResultOf<Def> =
	Def extends ProcedureDef<infer _S, infer _ST, infer _C, infer R> ? Awaited<R> : never

export type Client<A> =
	A extends App<infer State, infer Acts, infer _Caps, infer Procs>
		? {
				[K in keyof Acts & string]: (params: ParamsOf<Acts[K]>) => Promise<ResultOf<Acts[K], State>>
			} & {
				[K in keyof Procs & string]: (
					params: ProcParamsOf<Procs[K]>
				) => Promise<ProcResultOf<Procs[K]>>
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
