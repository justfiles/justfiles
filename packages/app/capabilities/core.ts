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
	Streams = Record<string, never>
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
export function defineCapability<Id extends string, Methods, Streams = Record<string, never>>(
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
	invoke(req: { capability: string; method: string; input: unknown }): Promise<unknown>
}
