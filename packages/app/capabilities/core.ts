// Public capability primitives. Apps consume capabilities the way iOS apps
// consume system frameworks — they cannot invent new ones; the host
// registers implementations. This module is app-safe: pure types + a small
// factory helper, no Cloudflare or provider imports.

export type CapabilityScope = string

/**
 * Factory returned by `defineCapability`. Apps call it with their requested
 * scopes; the host broker enforces method-level grants at invocation time.
 *
 * `Methods` describes the request/response surface (what the app calls). The
 * optional `Events` describes the named pushes the kernel routes back into
 * the app's reducer via declared `on`-handlers — payload types flow from
 * here to the app at compile time.
 */
export type CapabilityFactory<Id extends string, Methods, Events = Record<string, never>> = (opts: {
	scopes: readonly CapabilityScope[]
}) => {
	id: Id
	scopes: readonly CapabilityScope[]
	readonly __methods?: Methods
	readonly __events?: Events
}

/**
 * Define a capability contract. The host owns implementations; this only
 * fixes the public id, method surface, and the named events it emits.
 */
export function defineCapability<Id extends string, Methods, Events = Record<string, never>>(
	id: Id
): CapabilityFactory<Id, Methods, Events> {
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
