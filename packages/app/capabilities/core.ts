// Public capability primitives. Apps consume capabilities the way iOS apps
// consume system frameworks — they cannot invent new ones; the host
// registers implementations. This module is app-safe: pure types + a small
// factory helper, no Cloudflare or provider imports.

export type CapabilityScope = string

/**
 * Factory returned by `defineCapability`. Apps call it with their requested
 * scopes; the host broker enforces method-level grants at invocation time.
 */
export type CapabilityFactory<Id extends string, Shape> = (opts: {
	scopes: readonly CapabilityScope[]
}) => { id: Id; scopes: readonly CapabilityScope[]; readonly __shape?: Shape }

/**
 * Define a capability contract. The host owns implementations; this only
 * fixes the public id and shape.
 */
export function defineCapability<Id extends string, Shape>(id: Id): CapabilityFactory<Id, Shape> {
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
