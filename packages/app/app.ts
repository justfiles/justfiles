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
// it, routing the result to the `to` edge as a `__cmd/<to>` message. `args` is
// the method's positional argument list (typed at the builder, opaque here).
export type Command =
	| { kind: 'none' }
	| { kind: 'batch'; commands: Command[] }
	| {
			kind: 'capability'
			capability: string
			method: string
			args: readonly unknown[]
			to: string
			// Opt-in single-flight (Part B). When set, the command runtime keys the
			// command by {capability,method,args,to} per app: if an identical one is
			// already in flight it is NOT started again — instead the runtime folds a
			// trailing re-run once the current lands (so a burst collapses into at most
			// one extra pass). Only safe for idempotent, query-like effects (a scan);
			// never for accumulating writes (an append) where each call must run.
			coalesce?: true
	  }

// A capability command awaiting its result edge. `t.cmd(cap, method, ...args)`
// returns this so the variadic `args` stay last; `.to(edge)` names the
// `t.fromResult` edge that receives the result, completing the `Command`.
// `.coalesce()` opts the command into runtime single-flight (see `Command`).
export interface CommandBuilder {
	to(edge: string): Command
	coalesce(): CommandBuilder
}

// An ongoing stream the CURRENT state declares (Part D) — the dual of a Command
// (which a transition emits one-shot). `subscriptions(state)` returns these;
// the kernel diffs the set on every commit, starting/stopping host streams by the
// whole descriptor — `coalesce` included, so flipping the mode restarts the stream
// instead of reading as "unchanged". Each emitted event re-enters the reducer as a
// `__sub/<to>` message handled by a `t.fromEvent` edge. `capability` names a LOCAL
// capability; the kernel resolves trust.
export interface Subscription {
	capability: string
	method: string
	args: readonly unknown[]
	to: string
	// Opt in to runtime coalescing: while a dispatch for this stream is outstanding,
	// further events fold into ONE trailing dispatch carrying the newest payload.
	// Declare it when an event is a WAKE — it says "re-read", and an unreduced older
	// one is fully superseded by a newer one (`volume.watch`). Leave it off when every
	// event carries information of its own, where dropping one loses data.
	coalesce?: true
}

// The streaming dual of `CommandBuilder`. `sub.capability(cap, method, ...args)`
// returns this; `.to(edge)` names the `t.fromEvent` edge that folds each event,
// and `.coalesce()` opts into runtime coalescing (see `Subscription`).
export interface SubscriptionBuilder {
	to(edge: string): Subscription
	coalesce(): SubscriptionBuilder
}

// What a `fromResult` edge receives once a capability call settles.
export type Result<T> = { ok: true; value: T } | { ok: false; error: { message: string } }

// Per-capability method args/output, derived from the contract interface. A
// method is ANY function `(...args) => R`; `MethodArgs` is its full positional
// argument tuple (spread into `t.cmd`/`app.invoke`) and `MethodOutput` is
// `Awaited<R>` — the capability boundary is always async, so a synchronous
// contract return still arrives as a Promise (`invoke`) or Result (`fromResult`).
type MethodArgs<M, K extends keyof M> = M[K] extends (...args: infer A) => unknown ? A : never
type MethodOutput<M, K extends keyof M> = M[K] extends (...args: any[]) => infer R
	? Awaited<R>
	: never

// Per-capability stream args/event, derived from the contract's `Stream` decl
// (`name(...args): Stream<Event>`). `StreamArgs` types `sub.capability`'s args;
// `StreamEvent` types the `t.fromEvent` edge's payload.
type StreamArgs<S, K extends keyof S> = S[K] extends (...args: infer A) => unknown ? A : never
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
	// build a capability command; `args` are typed (and spread) from the contract
	// and the returned builder's `.to(edge)` names the edge that receives the result
	cmd<C extends keyof Caps & string, M extends keyof MethodsOf<Caps[C]> & string>(
		capability: C,
		method: M,
		...args: MethodArgs<MethodsOf<Caps[C]>, M>
	): CommandBuilder
}

// The `sub` builder passed to `subscriptions(state, sub)`. Mirrors `t.cmd` but
// declares an ONGOING stream rather than a one-shot command: `args` are typed
// from the contract's `Stream` decl and the builder's `.to(edge)` names the
// `t.fromEvent` edge that folds each event. The kernel resolves trust + scopes.
export interface Subs<Caps extends CapabilityRequests> {
	capability<C extends keyof Caps & string, M extends keyof StreamsOf<Caps[C]> & string>(
		capability: C,
		method: M,
		...args: StreamArgs<StreamsOf<Caps[C]>, M>
	): SubscriptionBuilder
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
	// the kernel resolves the trusted id + scopes; `args` and the result are
	// typed from the contract (same machinery as `cmd`).
	invoke<C extends keyof Caps & string, M extends keyof MethodsOf<Caps[C]> & string>(
		capability: C,
		method: M,
		...args: MethodArgs<MethodsOf<Caps[C]>, M>
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
	invoke(capability: string, method: string, ...args: unknown[]): Promise<unknown>
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
	// The reducer's bootstrap state. GUI adapters use this to render a non-null
	// initial frame before the host has any persisted state to push.
	readonly initialState: State
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

// Declared capabilities as static metadata: local name -> { id, scopes }. Mirrors
// the runtime `App.capabilities`; the build emits it into the manifest so the
// store can show capabilities on the consent sheet and gate escalation on update
// WITHOUT running the app.
export type CapabilityDecl = Record<string, { id: string; scopes: string[] }>

/**
 * The installed-app record — and, when the app is hosted, the whole of it.
 *
 * `baseUrl` is what splits the two shapes. With one, the manifest is a SPEC: an
 * immutable, version-pinned origin the bytes are mounted from, plus the hashes that
 * identify them. `/applications/<id>/` then holds this file and the reducer; mounted
 * bytes use the host's HTTP cache and never replicate because the origin can re-serve
 * them. Without one, the bundle IS the bytes: they are
 * copied into `/applications/<id>/` and replicate, which is the only correct answer
 * for an app authored locally (a devkit draft has no upstream to refetch from).
 *
 * That makes residency a CONSEQUENCE of the spec rather than a separate flag, and it
 * makes the record self-describing: a device can validate and repair an app it has
 * only ever received over sync, with no catalog of its own to consult.
 */
export interface AppManifest {
	id: string
	name: string
	description?: string
	version?: string
	icon?: string
	app: string
	gui?: string
	cli?: string
	include?: string[]
	capabilities?: CapabilityDecl
	// The origin this app's bytes are mounted from — version-pinned and immutable, so
	// it addresses exactly the release this record describes. Written by the installer
	// from the catalog entry, never declared by the app itself. Absent ⇒ the bundle's
	// bytes were copied into the volume and replicate.
	baseUrl?: string
	// Whole-app fingerprint, folding every file's hash. What the update path compares
	// to decide whether the installed app is still the published one.
	hash?: string
	// Bundle path → `sha256-<hex>`, for the files `baseUrl` serves. The integrity pin
	// travels WITH the record instead of living in a catalog, so a fetched byte can be
	// verified by a device whose own release never carried this version.
	files?: Record<string, string>
}

// Is this app's payload mounted from an origin rather than stored in the volume?
export function isHosted(manifest: Pick<AppManifest, 'baseUrl'>): boolean {
	return typeof manifest.baseUrl === 'string' && manifest.baseUrl.length > 0
}

// Is this bundle file mounted from the origin, or does it live in the volume?
//
// The REDUCER never mounts, even for a hosted app. A headless kernel runs it with no
// service worker and an assets binding that only ever holds the CURRENT release, so a
// record that outlives its release would leave the agent unable to run an app the user
// has installed — the one case the volume is the only durable answer for. It is also
// the cheap half to keep: #373 leaves reducers framework-free by construction, while
// the GUI is where the bytes actually are.
export function isMountedFile(
	manifest: Pick<AppManifest, 'app' | 'baseUrl'>,
	path: string
): boolean {
	return isHosted(manifest) && path !== manifest.app
}

export interface AppBundle {
	manifest(): Promise<AppManifest>
	list(): AsyncIterable<string>
	read(path: string): Promise<Uint8Array>
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
