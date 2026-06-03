// biome-ignore-all lint/suspicious/noExplicitAny: variance-load-bearing — see ActionDef comment
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { CapabilityFactory } from './capabilities/core.ts'

type MaybePromise<T> = T | Promise<T>
type Infer<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>

export type Message<Type extends string = string, Params = unknown> = {
	type: Type
	params: Params
	actor?: string
}

export interface ActionExample {
	params: Record<string, unknown>
	description?: string
}

// `kind` lets agents and tooling distinguish state-mutating handlers from
// pure-read queries. A handler returns the next state; a query returns an
// arbitrary value and never persists.
export interface ActionMeta {
	kind: 'handler' | 'query'
	description?: string
	examples?: ActionExample[]
	schemaHint?: unknown
}

// What a bundle's `dispatch` returns. Handlers populate `state` (saved and
// pushed to subscribers); queries leave it absent. Both populate `result`,
// which is what the dispatching caller receives — for handlers that's the
// new state, for queries it's whatever the query returned.
export interface DispatchResult<State> {
	state?: State
	result: unknown
}

type CapabilityRequest<
	Id extends string = string,
	Methods = unknown,
	Events = unknown
> = ReturnType<CapabilityFactory<Id, Methods, Events>>
type CapabilityRequests = Record<string, CapabilityRequest>
type NoCapabilities = Record<string, never>
type CapabilityInvocation = {
	capability: string
	method: string
	input: unknown
	// Scopes the app declared on the capability request. The host enforces
	// what's actually allowed; the SDK just forwards what the app said it
	// wanted, so the host can pick narrower implementations per scope.
	scopes: readonly string[]
	actor?: string
}
type CapabilityInvoke = (req: CapabilityInvocation) => Promise<unknown>

// Per-capability methods injected as `ctx.capabilities.<id>`.
type MethodsOf<C> = C extends CapabilityRequest<string, infer M, infer _E> ? M : never
// Per-capability declared events — the kernel routes these into the app's
// reducer via declared `on`-handlers (see OnHandlers below).
export type EventsOf<C> = C extends CapabilityRequest<string, infer _M, infer E> ? E : never
type InjectedCapabilities<Caps extends CapabilityRequests> = {
	readonly [K in keyof Caps]: MethodsOf<Caps[K]>
}

// `on` shape: keyed by capability name (from `capabilities`), then by event
// name (from that capability's declared events). Both levels are optional —
// handle what you care about, skip the rest.
export type OnHandlers<State, Caps extends CapabilityRequests> = {
	[C in keyof Caps & string]?: {
		[E in keyof EventsOf<Caps[C]> & string]?: (
			event: EventsOf<Caps[C]>[E],
			ctx: Context<State, Caps>
		) => MaybePromise<State>
	}
}

// HandlerDef / QueryDef live here (not in sdk.ts) so the App<> bound can
// be `Record<string, ActionDef<...>>` — without the cycle that would arise
// from app.ts importing from sdk.ts.
export interface HandlerDef<S extends StandardSchemaV1, State, Caps extends CapabilityRequests> {
	readonly __kind: 'handler'
	schema: S
	description?: string
	examples?: ActionExample[]
	handler: (params: Infer<S>, ctx: Context<State, Caps>) => MaybePromise<State>
}

export interface QueryDef<S extends StandardSchemaV1, State, Caps extends CapabilityRequests, R> {
	readonly __kind: 'query'
	schema: S
	description?: string
	examples?: ActionExample[]
	handler: (params: Infer<S>, ctx: Context<State, Caps>) => MaybePromise<R>
}

// Constraint shape for the `Acts` generic on `App`. `any` for the schema
// position so the handler's `Infer<any>` = `any` params accept literals'
// narrower types without tripping strict function-parameter
// contravariance. Per-action S and R are preserved on the literal Acts
// inferred at the `defineApp` call site.
export type ActionDef<State, Caps extends CapabilityRequests = CapabilityRequests> =
	| HandlerDef<StandardSchemaV1<any, any>, State, Caps>
	| QueryDef<StandardSchemaV1<any, any>, State, Caps, any>

// Generic order is `<State, Acts, Caps>` to keep `App<typeof spec>`-style
// extraction sites stable. `Acts`'s constraint references `Caps`, which
// would normally force `Caps` to be declared first, but TypeScript only
// rejects forward references in *defaults* — the constraint itself is
// fine. So we drop the default on `Acts` (it's always inferred at call
// sites anyway) and keep the order.
export interface App<
	State,
	Acts extends Record<string, ActionDef<State, Caps>>,
	Caps extends CapabilityRequests = NoCapabilities
> {
	actions: Record<keyof Acts & string, ActionMeta>
	// Phantom carriers — only used by the type-level `Client<A>` extractor.
	readonly __acts?: Acts
	readonly __capabilities?: Caps
	dispatch: (message: Message, ctx: RuntimeContext<State>) => Promise<DispatchResult<State>>
}

export interface Context<State = unknown, Caps extends CapabilityRequests = NoCapabilities> {
	setState: (state: State) => Promise<void>
	readonly state: State
	readonly capabilities: InjectedCapabilities<Caps>
}

export interface RuntimeContext<State = unknown> {
	setState: (state: State) => Promise<void>
	readonly state: State
	capabilityInvoke?: CapabilityInvoke
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
