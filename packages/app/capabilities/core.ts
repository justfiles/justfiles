// Public capability primitives. Apps consume capabilities the way iOS apps
// consume system frameworks — they cannot invent new ones; the host
// registers implementations. This module is app-safe: pure types + a small
// factory helper, no Cloudflare or provider imports.

export type CapabilityScope = string

/**
 * Phantom carrier for a capability *stream* (Part D). A stream is declared in a
 * capability's `Streams` surface as `name(input): Stream<Event>` — unlike a
 * one-shot `Method`, the host runs it as `(input, emit) => unsubscribe` and the
 * kernel routes each emitted `Event` back into the app's reducer as a
 * `t.fromEvent` edge. The phantom `Event` carries that payload type to the edge,
 * so authors never restate it. Types-only: no value is ever constructed.
 */
export type Stream<Event> = { readonly __event?: Event }

/**
 * Runtime twin of one contract method — optional, supplied to `defineCapability`.
 * A capability that carries it becomes self-describing: `implementTool` derives
 * agent tools from it, and seam-level input validation can consume it later.
 */
export interface MethodMeta {
	/** What the method does. Doubles as the derived tool's LLM-facing description. */
	description: string
	/** JSON Schema for the method's single input argument. */
	input: Record<string, unknown>
}

export type MethodMetaMap<Methods> = Partial<Record<Extract<keyof Methods, string>, MethodMeta>>

/**
 * Factory returned by `defineCapability`. Apps call it with their requested
 * scopes; the host broker enforces method-level grants at invocation time.
 *
 * `Methods` describes the one-shot request/response surface (what the app
 * calls). The optional `Streams` describes the ongoing streams the app may
 * subscribe to via `subscriptions(state)`; both the input and the emitted-event
 * types flow from here to the app at compile time. The factory also carries the
 * contract's runtime side — `id` plus any per-method metadata — so hosts can
 * derive from the contract without calling it.
 */
export type CapabilityFactory<
	Id extends string,
	Methods,
	// Default has `keyof = never` (not `Record<string, never>`, whose `keyof` is
	// `string`) so a stream-less capability's `implementCapability` impl maps to
	// `{}` and requires no stream handlers.
	Streams = Record<never, never>
> = ((opts: { scopes: readonly CapabilityScope[] }) => {
	id: Id
	scopes: readonly CapabilityScope[]
	readonly __methods?: Methods
	readonly __streams?: Streams
}) & { id: Id; methods?: MethodMetaMap<Methods> }

/**
 * Define a capability contract. The host owns implementations; this only
 * fixes the public id, the one-shot method surface, and the streams it emits.
 * `methods` metadata is optional and additive — supply it to make the contract
 * self-describing (see `implementTool`).
 */
export function defineCapability<Id extends string, Methods, Streams = Record<never, never>>(
	id: Id,
	methods?: MethodMetaMap<Methods>
): CapabilityFactory<Id, Methods, Streams> {
	return Object.assign(
		(opts: { scopes: readonly CapabilityScope[] }) => ({ id, scopes: opts.scopes }),
		{ id, methods }
	)
}

/**
 * Generic capability invocation transport. The broker exposes one of these,
 * and the worker's `app.capability.invoke` RPC handler routes through it.
 * Implementations throw `{ code: 'CAPABILITY_DENIED' | 'CAPABILITY_FAILED' }`
 * with optional `message` so the host can map them to stable RPC errors.
 */
export interface CapabilityBridge {
	invoke(req: { capability: string; method: string; args: readonly unknown[] }): Promise<unknown>
}

// ── Capability-provided agent tools ─────────────────────────────────────────
// A capability's AGENT-facing surface, described runtime-neutrally so it lives
// in this pi-free layer: name/description/JSON-schema parameters plus an
// `execute` over the capability's own invoke. `@justfiles/agent` holds the one
// adapter that turns descriptors into real agent tools — the dependency edge
// stays agent → app, never back.

/**
 * The capability's own invoke, pre-bound by the adapter to the agent actor and
 * this one capability. Parameterized by the contract so a tool derived via
 * `implementTool` gets compile-checked method names, inputs, and results —
 * contract drift becomes a type error, not a runtime surprise.
 */
export type ScopedInvoke<Methods = Record<string, (...args: unknown[]) => unknown>> = <
	K extends Extract<keyof Methods, string>
>(
	method: K,
	...args: Methods[K] extends (...a: infer A) => unknown ? A : never[]
) => Promise<Methods[K] extends (...a: never[]) => infer R ? Awaited<R> : unknown>

// What `execute` may need beyond the capability itself. `volume` lets a tool
// offload bulky payloads (image bytes) to files instead of returning them to
// the model; passthrough tools ignore it.
export interface CapabilityToolContext {
	volume: import('@justfiles/fs').Volume
}

// A structured return: `content` is the text the model sees; `details` never
// reaches the model (it is the transcript/UI channel). Any other return value
// is JSON-serialized into the model-facing text instead.
export interface CapabilityToolResult {
	content: string
	details?: unknown
}

export interface CapabilityTool<Params = unknown> {
	name: string
	description: string
	/** JSON Schema for the params object; the adapter hands it to the agent runtime as-is. */
	parameters: Record<string, unknown>
	execute(
		invoke: ScopedInvoke,
		params: Params,
		ctx: CapabilityToolContext
	): Promise<CapabilityToolResult | unknown>
}

/** One capability's contributed tools, as `createAgentSession` consumes them. */
export interface CapabilityToolSet {
	capability: string
	tools: CapabilityTool[]
}

/** The input type of a one-arg contract method, for typing derived tool params. */
type MethodInput<F> = F extends (input: infer I) => unknown ? I : never

/**
 * Per-method override for `implementTool` — only where derivation can't reach:
 * LLM-facing copy that differs from the contract description, a friendlier tool
 * name, or an `execute` that transforms rather than passes through (e.g. offload
 * bytes to the Volume so they never enter model context).
 */
export interface ToolOverride<Methods, K extends Extract<keyof Methods, string>> {
	/** Agent-visible name. Default: `<capability>_<method_in_snake_case>`. */
	name?: string
	/** LLM-facing description. Default: the method's contract description. */
	description?: string
	/** Replaces the default passthrough `invoke(method, params)`. */
	execute?(
		invoke: ScopedInvoke<Methods>,
		params: MethodInput<Methods[K]>,
		ctx: CapabilityToolContext
	): Promise<CapabilityToolResult | unknown>
}

/**
 * Derive a capability's agent tools from its contract metadata — the tool-side
 * counterpart of `implementCapability`. Every method with `MethodMeta` becomes a
 * tool: schema and description from the contract, execute a plain passthrough
 * unless overridden. The contract stays the single source of truth; overrides
 * carry only judgment.
 */
export function implementTool<Id extends string, Methods>(
	factory: CapabilityFactory<Id, Methods, never> | CapabilityFactory<Id, Methods>,
	overrides: { [K in Extract<keyof Methods, string>]?: ToolOverride<Methods, K> } = {}
): CapabilityToolSet {
	const tools: CapabilityTool[] = []
	for (const [method, meta] of Object.entries(factory.methods ?? {}) as [string, MethodMeta][]) {
		if (!meta) continue
		const over = (overrides as Record<string, ToolOverride<Methods, never> | undefined>)[method]
		tools.push({
			name: over?.name ?? `${factory.id}_${snakeCase(method)}`,
			description: over?.description ?? meta.description,
			parameters: meta.input,
			execute: (over?.execute ??
				((invoke, params) => invoke(method, params))) as CapabilityTool['execute']
		})
	}
	return { capability: factory.id, tools }
}

function snakeCase(name: string): string {
	return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}
