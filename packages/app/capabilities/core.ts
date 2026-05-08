// Public capability primitives. Apps consume capabilities the way iOS apps
// consume system frameworks — they cannot invent new ones; the host
// registers implementations. This module is app-safe: pure types + a small
// factory helper, no Cloudflare or provider imports.

export type CapabilityScope = string

/**
 * A bound capability declaration on an engine. `Id` identifies the
 * capability at runtime; `Shape` is the typed app-facing contract carried as
 * a phantom so `withCapabilities([...])` can derive `ctx.capabilities[id]`.
 */
export type CapabilityInstance<Id extends string = string, Shape = unknown> = {
	id: Id
	scopes: readonly CapabilityScope[]
	readonly __shape?: Shape
}

/**
 * Factory returned by `defineCapability`. Apps call it with their requested
 * scopes inside `engine().withCapabilities([...])`.
 */
export type CapabilityFactory<Id extends string, Shape> = (opts: {
	scopes: readonly CapabilityScope[]
}) => CapabilityInstance<Id, Shape>

/**
 * Define a capability contract. The host owns implementations; this only
 * fixes the public id and shape.
 */
export function defineCapability<Id extends string, Shape>(id: Id): CapabilityFactory<Id, Shape> {
	return (opts) => ({ id, scopes: opts.scopes })
}

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
	x: infer I
) => void
	? I
	: never

/**
 * Map a tuple of capability instances to `{ [id]: Shape }`. Used by the
 * engine builder to type `ctx.capabilities` in task handlers.
 */
export type CapsFromInstances<C extends readonly CapabilityInstance[]> = UnionToIntersection<
	{
		[K in keyof C]: C[K] extends CapabilityInstance<infer Id, infer Shape>
			? Id extends string
				? { [P in Id]: Shape }
				: never
			: never
	}[number]
>
