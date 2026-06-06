// The one capability seam. Everything above it (kernel, app) speaks this; every
// backend below it (local unit, registry, remote proxy) implements it.
//
// A `CapabilityCall` is the single request type. Scopes are TRUSTED — the kernel
// resolves them from the app's bundle and attaches them here; the isolate never
// supplies them. `input` stays `unknown` at the seam (types live at the ends).

export interface CapabilityCall {
	appId: string
	capability: string
	method: string
	input: unknown
	scopes: readonly string[]
	actor?: string
}

export type Emit = (event: unknown) => void
export type Unsubscribe = () => void

// Two arms, one substrate: 1:1 returns a `Promise`, 1:N returns an
// `Unsubscribe`. The kernel calls `subscribe` only for methods the app declared
// as `Stream`s, so a unit never has to route between the two itself.
export interface Capabilities {
	invoke(call: CapabilityCall): Promise<unknown>
	subscribe(call: CapabilityCall, emit: Emit): Promise<Unsubscribe>
}

// A `Capability` is just a `Capabilities` scoped to one name — the registry maps
// names to these and composes them back into a single `Capabilities`.
export type Capability = Capabilities
