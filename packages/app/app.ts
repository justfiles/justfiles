// biome-ignore-all lint/suspicious/noExplicitAny: variance-load-bearing — see Edge/ProcedureDefs comments
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { CapabilityFactory, Stream } from './capabilities/core.ts'
import type { Edge as MachineEdge, Message, Transition } from './machine.ts'

// Re-surface the machine's `Message` so the kernel and the package's public
// surface keep importing the dispatch vocabulary from here.
export type { Message } from './machine.ts'

type MaybePromise<T> = T | Promise<T>
type Infer<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>

export interface ActionExample {
	params: Record<string, unknown>
	description?: string
}

// `kind` lets agents and tooling distinguish state-mutating edges (`handler`)
// from procedures (the imperative facade). A public edge dispatches into the
// reducer and persists the next state; a procedure drives the reducer and
// returns a value to its caller.
export interface ActionMeta {
	kind: 'handler' | 'procedure'
	// Set only for procedures — see ProcedureAudience. The kernel uses it to
	// hide 'gui' procedures from the agent's tool list.
	audience?: ProcedureAudience
	description?: string
	examples?: ActionExample[]
	schemaHint?: unknown
}

// What a bundle's `dispatch` returns. A public edge (or `on`-event) populates
// `state` (saved and pushed to subscribers); `result` is what the dispatching
// caller receives — for an edge that's the new state.
export interface DispatchResult<State> {
	state?: State
	// The effect the edge emitted, interpreted as a Command (Part B). The kernel
	// executes it and routes the result back as another message; until then it is
	// simply surfaced here. Absent for non-emitting transitions.
	command?: Command
	// The streams the NEW state declares (Part D), computed alongside the reduce
	// so the kernel diffs the set without a second round-trip. Present only when
	// the transition produced a state; the kernel ignores it otherwise.
	subscriptions?: Subscription[]
	result: unknown
}

type CapabilityRequest<
	Id extends string = string,
	Methods = unknown,
	Events = unknown
> = ReturnType<CapabilityFactory<Id, Methods, Events>>
type CapabilityRequests = Record<string, CapabilityRequest>
type NoCapabilities = Record<string, never>
type NoProcedures = Record<string, never>

// Per-capability method map, used to type `t.cmd`/`t.fromResult`/`app.invoke`.
type MethodsOf<C> = C extends CapabilityRequest<string, infer M, infer _S> ? M : never
// Per-capability stream map (Part D), used to type `sub.capability`/`t.fromEvent`.
type StreamsOf<C> = C extends CapabilityRequest<string, infer _M, infer S> ? S : never

// ----- effects & typed edges (the Command / Subscription add-ons) -----
// The machine (machine.ts) is effect-agnostic. Here we pin its `Effect` to
// `Command` and hand the author the typed `Edges` builder. An edge stays
// `(state, payload) → state | [state, command]`: synchronous, no `ctx`, no
// capabilities. Effects are described as data (Command/Subscription) and run by
// the kernel. These are the layers the machine is meant to outlive — they can
// later move to their own modules without touching machine.ts.

// A side effect described as data. `capability` names a LOCAL capability (the
// app's declared key); the kernel resolves the trusted id + scopes and runs
// it, routing the result to the `to` edge as a `__cmd/<to>` message.
export type Command =
	| { kind: 'none' }
	| { kind: 'batch'; commands: Command[] }
	| { kind: 'capability'; capability: string; method: string; input: unknown; to: string }

// An ongoing stream the CURRENT state declares (Part D) — the dual of a Command
// (which a transition emits one-shot). `subscriptions(state)` returns these;
// the kernel diffs the set on every commit, starting/stopping host streams by
// the structural key `{capability, method, input, to}`. Each emitted event
// re-enters the reducer as a `__sub/<to>` message handled by a `t.fromEvent`
// edge. `capability` names a LOCAL capability; the kernel resolves trust.
export interface Subscription {
	capability: string
	method: string
	input: unknown
	to: string
}

// What a `fromResult` edge receives once a capability call settles.
export type Result<T> = { ok: true; value: T } | { ok: false; error: { message: string } }

// Per-capability method input/output, derived from the contract interface.
type MethodInput<M, K extends keyof M> = M[K] extends (input: infer I) => unknown ? I : never
type MethodOutput<M, K extends keyof M> = M[K] extends (...args: any[]) => Promise<infer O>
	? O
	: never

// Per-capability stream input/event, derived from the contract's `Stream` decl
// (`name(input): Stream<Event>`). `StreamInput` types `sub.capability`'s input;
// `StreamEvent` types the `t.fromEvent` edge's payload.
type StreamInput<S, K extends keyof S> = S[K] extends (input: infer I) => unknown ? I : never
type StreamEvent<S, K extends keyof S> = S[K] extends (...args: any[]) => Stream<infer E>
	? E
	: never

// A machine edge with `Effect` pinned to `Command`, plus the add-on metadata the
// SDK needs: `__edge` discriminates the dispatch path (so the SDK keys internal
// edges onto their `__cmd/`/`__sub/` message types and keeps them off the public
// surface); `description`/`examples` are the agent-facing meta. `S` carries the
// schema type into `Client<A>` for public `on` edges; it is erased
// (`Edge<State>`) for internal `fromResult`/`commit` edges.
export interface Edge<State, S extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined>
	extends MachineEdge<State, Command, S> {
	readonly __edge: 'on' | 'result' | 'commit' | 'event'
	// Public-edge meta surfaced to the agent's tool list. Internal `fromResult`
	// edges carry neither.
	description?: string
	examples?: ActionExample[]
}

// The `t` builder passed to `update`. Each constructor infers its payload
// type from a schema or a capability contract; all return the erased
// `Edge<State>` the table stores.
export interface Edges<State, Caps extends CapabilityRequests> {
	// public edge — declares an input schema, so it IS the external API
	// (validated, agent-visible, consumer-dispatchable). Optional `meta` carries
	// the agent-facing description/examples.
	on<S extends StandardSchemaV1>(
		schema: S,
		transition: Transition<State, Infer<S>, Command>,
		meta?: { description?: string; examples?: ActionExample[] }
	): Edge<State, S>
	// internal commit edge — validated like `on`, but kept OFF the public/agent
	// action surface AND the typed client. Only the app's own procedures dispatch
	// it by name (via `app.dispatch`), to commit a result they computed off to the
	// side (a fully-built puzzle, a recorded build outcome). Returns the erased
	// `Edge<State>` so its schema rides at runtime for validation but never
	// surfaces on `Client<A>`.
	commit<S extends StandardSchemaV1>(
		schema: S,
		transition: Transition<State, Infer<S>, Command>
	): Edge<State>
	// internal edge — payload is a capability result, typed from the contract
	fromResult<C extends keyof Caps & string, M extends keyof MethodsOf<Caps[C]> & string>(
		capability: C,
		method: M,
		transition: Transition<State, Result<MethodOutput<MethodsOf<Caps[C]>, M>>, Command>
	): Edge<State, undefined>
	// internal edge — payload is a capability STREAM event (Part D), typed from
	// the contract's `Stream<Event>`. Fed by a `subscriptions(state)` entry the
	// kernel keeps alive; events arrive as `__sub/<to>` messages.
	fromEvent<C extends keyof Caps & string, M extends keyof StreamsOf<Caps[C]> & string>(
		capability: C,
		method: M,
		transition: Transition<State, StreamEvent<StreamsOf<Caps[C]>, M>, Command>
	): Edge<State, undefined>
	// build a capability command; `input` is typed from the contract and `to`
	// names the edge that receives the result
	cmd<C extends keyof Caps & string, M extends keyof MethodsOf<Caps[C]> & string>(
		capability: C,
		method: M,
		input: MethodInput<MethodsOf<Caps[C]>, M>,
		to: string
	): Command
}

// The `sub` builder passed to `subscriptions(state, sub)`. Mirrors `t.cmd` but
// declares an ONGOING stream rather than a one-shot command: `input` is typed
// from the contract's `Stream` decl and `to` names the `t.fromEvent` edge that
// folds each event. The kernel resolves the trusted capability id + scopes.
export interface Subs<Caps extends CapabilityRequests> {
	capability<C extends keyof Caps & string, M extends keyof StreamsOf<Caps[C]> & string>(
		capability: C,
		method: M,
		input: StreamInput<StreamsOf<Caps[C]>, M>,
		to: string
	): Subscription
}

// ----- procedures (Part C) -----
// The imperative facade. An async function over an AppHandle that drives the
// reducer and reads capabilities, returning a value to its caller. ONE
// definition serves the GUI (via the client) and the agent (auto-exposed as a
// tool). Optional — an app with none still works through the dispatch default
// (a plain agent dispatch resolves with the settled state).

// What a procedure receives to drive the app. Data-only against the kernel:
// `dispatch` and `read` round-trip through the kernel (which owns trust), so a
// procedure stays imperative without ever holding a capability or touching
// reducer purity. Procedures are never serialized — they suspend at `settled`.
export interface AppHandle<State, Caps extends CapabilityRequests = NoCapabilities> {
	readonly state: State
	dispatch(message: Message): Promise<{ seq: number }>
	settled(seq: number, opts?: { timeout?: number }): Promise<State>
	// Kernel-mediated, scope-checked capability invocation — the procedure-side
	// parallel to the reducer's `cmd`: `cmd` routes the result back INTO state,
	// `invoke` returns it TO the caller. `capability` is the app's LOCAL name;
	// the kernel resolves the trusted id + scopes; `input` and the result are
	// typed from the contract (same machinery as `cmd`).
	invoke<C extends keyof Caps & string, M extends keyof MethodsOf<Caps[C]> & string>(
		capability: C,
		method: M,
		input: MethodInput<MethodsOf<Caps[C]>, M>
	): Promise<MethodOutput<MethodsOf<Caps[C]>, M>>
}

// The Caps-erased handle the kernel builds and forwards across the sandbox
// boundary (RPC / postMessage). The infra calls `invoke` with plain strings
// (the kernel resolves the trusted id + scopes at runtime); the bundle re-types
// it as the per-app `AppHandle<State, Caps>` so the typed capability surface
// lives at the author's `run`, not in this generic plumbing.
export interface RawAppHandle {
	readonly state: unknown
	dispatch(message: Message): Promise<{ seq: number }>
	settled(seq: number, opts?: { timeout?: number }): Promise<unknown>
	invoke(capability: string, method: string, input: unknown): Promise<unknown>
}

// 'gui' procedures are hidden from the agent's tool surface; 'agent' ones are
// not offered to the GUI client at runtime; 'both' (default) serves either.
export type ProcedureAudience = 'gui' | 'agent' | 'both'

export interface ProcedureDef<
	S extends StandardSchemaV1,
	State,
	Caps extends CapabilityRequests,
	R
> {
	readonly __kind: 'procedure'
	audience: ProcedureAudience
	description?: string
	schema: S
	run: (params: Infer<S>, app: AppHandle<State, Caps>) => MaybePromise<R>
}

// `any` in the schema slot keeps the bound bivariant — a specific procedure's
// `ProcedureDef<ObjectSchema, …>` stays assignable to it despite `S` appearing
// in `run`'s param (the same `any` trick `Edge` uses for its transition). The
// inferred `Procs` at the call site keeps the precise schema for `Client<A>`.
export type ProcedureDefs<State, Caps extends CapabilityRequests = CapabilityRequests> = Record<
	string,
	ProcedureDef<any, State, Caps, any>
>

// Generic order keeps `State` first so `App<typeof spec>` extraction sites
// (GUIState, Client) stay stable. `Procs`/`Edges_` are inferred at the
// `defineApp` call site; `Edges_` preserves each public edge's schema for
// `Client<A>`.
export interface App<
	State,
	Caps extends CapabilityRequests = NoCapabilities,
	Procs extends ProcedureDefs<State, Caps> = NoProcedures,
	Edges_ extends Record<string, Edge<State>> = Record<string, never>
> {
	// Public surface as runtime meta: public edges (kind 'handler') AND
	// procedures (kind 'procedure'). The kernel routes a dispatch by name here.
	actions: Record<string, ActionMeta>
	// Declared capabilities as runtime data: local name → { id, scopes }. The
	// kernel reads this (never the scopes the isolate forwards) to attach the
	// app's declared, trusted scopes to every capability invocation, and to
	// reject calls to capabilities the app never declared (Part B).
	capabilities: Record<string, { id: string; scopes: readonly string[] }>
	// Phantom carriers — only used by the type-level `Client<A>` extractor.
	readonly __capabilities?: Caps
	readonly __procs?: Procs
	// The `update` edge table, type-preserved so `Client<A>` can offer each
	// public edge as `(params) => Promise<State>`.
	readonly __edges?: Edges_
	dispatch: (message: Message, ctx: RuntimeContext<State>) => Promise<DispatchResult<State>>
	// Run a declared procedure: validate params, then call its `run` with the
	// handle. The kernel hands in a `RawAppHandle` across the (dynamic) sandbox
	// boundary; the bundle sees it as the typed `AppHandle<State, Caps>`.
	runProcedure: (name: string, params: unknown, app: AppHandle<State, Caps>) => Promise<unknown>
	// The streams the given state declares (Part D). Pure: the kernel calls this
	// after every commit, diffs the result against the running set, and starts/
	// stops host streams accordingly. Empty (`[]`) when the app declares none.
	subscriptions: (state: State) => Subscription[]
}

// What the kernel hands the bundle's `dispatch` across the sandbox boundary.
// A pure edge needs only `state`; effects ride out as command data, so there is
// no host callback to inject.
export interface RuntimeContext<State = unknown> {
	readonly state: State
}

export interface AppManifest {
	id: string
	name: string
	description?: string
	version?: string
	icon?: string
	app: string
	gui?: string
	cli?: string
}

export interface AppBundle {
	manifest(): Promise<AppManifest>
	list(): AsyncIterable<string>
	read(path: string): Promise<Uint8Array>
}

// Default-export shape of `dist/bundle.js` (generated by `kernelHost()` on
// build). Lets a host install a built app by `import paint from '<pkg>/bundle'`
// — bytes live in the generated module, no zip/unzip dance.
export interface BuiltinBundle {
	readonly id: string
	readonly version: string
	readonly manifest: AppManifest
	readonly files: Readonly<Record<string, Uint8Array>>
}

export interface MemoryAppBundle {
	id: string
	name: string
	description?: string
	version?: string
	icon?: string
	app: string
	gui?: string
	cli?: string
	assets?: Record<string, string | Uint8Array>
}

export function appBundleFromMemory(input: MemoryAppBundle): AppBundle {
	const files: Record<string, string | Uint8Array> = {
		'app.js': input.app,
		'gui.js': input.gui ?? '',
		'cli.js': input.cli ?? '',
		...input.assets
	}

	return {
		async manifest() {
			return {
				id: input.id,
				name: input.name,
				description: input.description,
				version: input.version,
				icon: input.icon,
				app: 'app.js',
				gui: 'gui.js',
				cli: 'cli.js'
			}
		},
		async *list() {
			yield* Object.keys(files)
		},
		async read(path) {
			const file = files[path]
			if (file == null) throw new Error(`file not found: ${path}`)
			return typeof file === 'string' ? bytes(file) : file
		}
	}
}

export interface InstalledApp {
	manifest: AppManifest
	read(path: string): Promise<Uint8Array>
}

export function safeBundlePath(path: string): string {
	if (!path || path.includes('\0')) throw new Error(`invalid app bundle path: ${path}`)
	if (path.startsWith('/') || path.startsWith('//'))
		throw new Error(`invalid app bundle path: ${path}`)
	const parts = path.split('/').filter((part) => part && part !== '.')
	if (parts.length === 0 || parts.some((part) => part === '..')) {
		throw new Error(`invalid app bundle path: ${path}`)
	}
	return parts.join('/')
}

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}
