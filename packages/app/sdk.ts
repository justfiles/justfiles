import type { StandardSchemaV1 } from '@standard-schema/spec'
import type {
	ActionMeta,
	App,
	AppHandle,
	Command,
	CommandBuilder,
	DispatchResult,
	Edge,
	Edges,
	Message,
	ProcedureAudience,
	ProcedureDef,
	ProcedureDefs,
	RuntimeContext,
	Subs,
	Subscription,
	SubscriptionBuilder
} from './app.ts'
import { buildMachine } from './machine.ts'

type MaybePromise<T> = T | Promise<T>
type Infer<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>

type Capabilities = Record<
	string,
	ReturnType<import('./capabilities/core.ts').CapabilityFactory<string, unknown, unknown>>
>

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
	Caps extends Capabilities,
	Procs extends ProcedureDefs<State, Caps>,
	E extends Record<string, Edge<State>>
> {
	init: State
	capabilities?: Caps
	// Pure-core edge table (Part A) — the app's whole state machine. One `update`
	// map of pure edges `(state, payload) → state | [state, command]`. Public
	// edges declare a schema via `t.on` (validated, agent-visible); internal edges
	// receive a typed capability result via `t.fromResult`. The returned table's
	// type is captured as `E` so each public edge surfaces on `Client<A>`.
	update?: (t: Edges<State, Caps>) => E
	// Declarative stream subscriptions (Part D) — a PURE function of state. Returns
	// the ongoing streams the current state declares (via the `sub` builder, typed
	// against `capabilities`). The kernel diffs this set on every commit, starting/
	// stopping host streams by structural key, and routes each emitted event to the
	// `t.fromEvent` edge named by its `to`. Optional — apps that need no live stream
	// omit it. Recoverable by construction: rebuilt from persisted state on boot.
	subscriptions?: (state: State, sub: Subs<Caps>) => Subscription[]
	// Procedures (Part C) — the optional imperative facade. The callback receives
	// the State/Caps-bound `p` so each procedure's schema and return type infer
	// per call. Apps that need none omit it entirely.
	procedures?: (p: Procedures<State, Caps>) => Procs
}

// Capability results re-enter the reducer as `__cmd/<edge>` messages (the kernel
// runs the command, then dispatches the result; Part B). The prefix keeps
// internal `fromResult` edges off the public, schema-validated path: a public
// `on` edge is keyed by its plain name, a result edge only under `__cmd/`.
// Exported so the kernel's command executor can address result edges by name.
export const CMD_RESULT_PREFIX = '__cmd/'

// Stream events re-enter the reducer as `__sub/<edge>` messages (Part D). The
// kernel keeps a `subscriptions(state)` stream alive and routes each emitted
// event here; the prefix keeps internal `fromEvent` edges off the public path,
// exactly like `__cmd/` for results. Exported so the kernel can address them.
export const SUB_EVENT_PREFIX = '__sub/'

export function defineApp<
	State,
	Caps extends Capabilities = Record<string, never>,
	Procs extends ProcedureDefs<State, Caps> = Record<string, never>,
	E extends Record<string, Edge<State>> = Record<string, never>
>(spec: AppSpec<State, Caps, Procs, E>): App<State, Caps, Procs, E> {
	// Pure-core edges (Part A). The builder erases payload types into the stored
	// `Edge<State>`; `cmd` returns command data. `fromResult`/`fromEvent`'s
	// capability/method are compile-time only (they type the payload) — the kernel
	// routes results/events by edge name, so the runtime ignores them here.
	const edgeBuilder: Edges<State, Caps> = {
		on: (schema, transition, meta) => ({
			__edge: 'on',
			schema,
			description: meta?.description,
			examples: meta?.examples,
			transition
		}),
		commit: (schema, transition) => ({ __edge: 'commit', schema, transition }),
		fromResult: (_capability, _method, transition) => ({ __edge: 'result', transition }),
		fromEvent: (_capability, _method, transition) => ({ __edge: 'event', transition }),
		cmd: (capability, method, ...args) => {
			// `.coalesce()` flips the opt-in flag; `.to(edge)` bakes it into the final
			// Command. Usage: `t.cmd(cap, method, ...args).coalesce().to(edge)`.
			const builder = (coalesce: boolean): CommandBuilder => ({
				to: (edge) => ({
					kind: 'capability',
					capability,
					method,
					args,
					to: edge,
					...(coalesce ? { coalesce: true } : {})
				}),
				coalesce: () => builder(true)
			})
			return builder(false)
		}
	}
	const edges = (spec.update?.(edgeBuilder) ?? {}) as Record<string, Edge<State>>

	// Route internal edges onto their prefixed message types, then compile the
	// pure machine. `on`/`commit` keep their plain name (a `commit` edge is reached
	// only by the app's own procedures dispatching it by name); a capability result
	// arrives as `__cmd/<name>` and a stream event as `__sub/<name>`, matching what
	// the kernel dispatches. The machine resolves by exact message type — the prefix
	// convention (a Command/Subscription concern) lives here, not in the machine.
	const routed: Record<string, Edge<State>> = {}
	for (const name in edges) {
		const edge = edges[name]
		if (!edge) continue
		const key =
			edge.__edge === 'result'
				? `${CMD_RESULT_PREFIX}${name}`
				: edge.__edge === 'event'
					? `${SUB_EVENT_PREFIX}${name}`
					: name
		routed[key] = edge
	}
	const machine = buildMachine<State, Command>(spec.init, routed)

	// `subscriptions(state)` is a pure function of state returning declared
	// streams (Part D). The `sub` builder mirrors `cmd` — it just packages the
	// stream descriptor as data; the kernel resolves trust and keeps it alive.
	const subBuilder: Subs<Caps> = {
		capability: (capability, method, ...args) => {
			// Mirrors `t.cmd`'s builder: `.coalesce()` flips the opt-in flag, `.to(edge)`
			// bakes it into the final Subscription.
			const builder = (coalesce: boolean): SubscriptionBuilder => ({
				to: (edge) => ({
					capability,
					method,
					args,
					to: edge,
					...(coalesce ? { coalesce: true as const } : {})
				}),
				coalesce: () => builder(true)
			})
			return builder(false)
		}
	}
	const computeSubs = (state: State): Subscription[] =>
		spec.subscriptions?.(state, subBuilder) ?? []

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
	// Only public `on` edges (those with a schema) join the action surface as
	// handlers. Internal `fromResult`/`fromEvent`/`commit` edges are not
	// `__edge: 'on'`, so they stay off the public, agent-visible list — a `commit`
	// edge is reachable only by the app's own procedures dispatching it by name.
	for (const type in edges) {
		const edge = edges[type]
		if (!edge || edge.__edge !== 'on' || !edge.schema) continue
		meta[type] = {
			kind: 'handler',
			description: edge.description,
			examples: edge.examples,
			schemaHint: schemaHint(edge.schema)
		}
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
		initialState: spec.init,
		actions: meta,
		capabilities: declaredCapabilities,
		// The boot/warm path: the kernel asks for the streams a persisted state
		// declares. `state` may be undefined before the first dispatch — default to
		// `init`, matching the reducer. The hot path instead folds the set into the
		// dispatch result below, so a state-changing dispatch needs no extra call.
		subscriptions(state): Subscription[] {
			return computeSubs(state ?? spec.init)
		},
		async runProcedure(name, params, app): Promise<unknown> {
			const def = procs[name]
			if (!def) throw new Error(`unknown procedure: ${name}`)
			const schema = def.schema as StandardSchemaV1
			const r = await schema['~standard'].validate(params)
			if (r.issues)
				throw new Error(`invalid params for ${name}: ${r.issues.map((i) => i.message).join('; ')}`)
			// The kernel can't default `state` to `init` (init lives here, in the
			// bundle), so fold it in — matching the machine's `state ?? init`.
			const handle = app.state == null ? { ...app, state: machine.init } : app
			return def.run(r.value as never, handle)
		},
		// A pure reduce over `state` via the machine: it returns the next state and
		// the edge's opaque `effect`, which this layer reads as a Command. Effects
		// ride out as data, so the kernel hands the bundle only the current state.
		// The new state's declared streams (Part D) are folded in here, alongside
		// the reduce, so the kernel diffs without a second round-trip.
		async dispatch(message: Message, ctx: RuntimeContext<State>): Promise<DispatchResult<State>> {
			const { state, effect } = await machine.step(ctx.state, message)
			const subscriptions = state !== undefined ? computeSubs(state) : undefined
			return { state, command: effect, subscriptions, result: state }
		}
	}
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

// Procedures are addressed by the same client/transport as edges; their params
// come from the schema and the result is the `run` return type.
type ProcParamsOf<Def> =
	Def extends ProcedureDef<infer S, infer _ST, infer _C, infer _R> ? Infer<S> : never
type ProcResultOf<Def> =
	Def extends ProcedureDef<infer _S, infer _ST, infer _C, infer R> ? Awaited<R> : never

// Public `update` edges on the client. Only `t.on` edges carry a schema `S`;
// `t.fromResult` edges (S = undefined) are internal and drop out. A dispatched
// edge resolves with the app's State (the new model the host pushes back).
type EdgeClient<E, State> = {
	[K in keyof E as E[K] extends Edge<infer _St, infer S>
		? S extends StandardSchemaV1
			? K
			: never
		: never]: E[K] extends Edge<infer _St, infer S>
		? S extends StandardSchemaV1
			? (params: Infer<S>) => Promise<State>
			: never
		: never
}

// `typeof app` -> the typed client: one method per public edge (resolving with
// the new State) and one per procedure (resolving with its `run` return type).
export type Client<A> =
	A extends App<infer State, infer _Caps, infer Procs, infer Edges_>
		? EdgeClient<Edges_, State> & {
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
