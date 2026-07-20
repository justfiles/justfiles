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
 * Factory returned by `defineCapability`. Apps call it with their requested
 * scopes; the host broker enforces method-level grants at invocation time.
 *
 * `Methods` describes the one-shot request/response surface (what the app
 * calls). The optional `Streams` describes the ongoing streams the app may
 * subscribe to via `subscriptions(state)`; both the input and the emitted-event
 * types flow from here to the app at compile time.
 */
export type CapabilityFactory<
	Id extends string,
	Methods,
	// Default has `keyof = never` (not `Record<string, never>`, whose `keyof` is
	// `string`) so a stream-less capability's `implementCapability` impl maps to
	// `{}` and requires no stream handlers.
	Streams = Record<never, never>
> = (opts: { scopes: readonly CapabilityScope[] }) => {
	id: Id
	scopes: readonly CapabilityScope[]
	readonly __methods?: Methods
	readonly __streams?: Streams
}

/**
 * Define a capability contract. The host owns implementations; this only
 * fixes the public id, the one-shot method surface, and the streams it emits.
 */
export function defineCapability<Id extends string, Methods, Streams = Record<never, never>>(
	id: Id
): CapabilityFactory<Id, Methods, Streams> {
	return (opts) => ({ id, scopes: opts.scopes })
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

// ── Capability-provided agent tools (interface-refactor plan, Step 3.5) ─────
// A capability's AGENT-facing surface, described runtime-neutrally so it lives
// in this pi-free layer: name/description/JSON-schema parameters plus an
// `execute` over the capability's own invoke. `@justfiles/agent` holds the one
// adapter that turns descriptors into real agent tools — the dependency edge
// stays agent → app, never back.

/** The capability's own invoke, pre-bound by the adapter to the agent actor and this one capability. */
export type ScopedInvoke = (method: string, ...args: unknown[]) => Promise<unknown>

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
