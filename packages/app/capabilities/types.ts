// The one capability seam. Everything above it (kernel, app) speaks this; every
// backend below it (local unit, registry, remote proxy) implements it.
//
// A `CapabilityCall` is the single request type. Scopes are TRUSTED — the kernel
// resolves them from the app's bundle and attaches them here; the isolate never
// supplies them. `args` is the method's positional argument list, opaque at the
// seam (types live at the ends): a contract method `(a, b) => r` rides as
// `[a, b]`, a one-arg method as `[input]`, a zero-arg method as `[]`.

export interface CapabilityCall {
	appId: string
	capability: string
	method: string
	args: readonly unknown[]
	scopes: readonly string[]
	actor?: string
	workspace?: { capability: string; scopes: readonly string[] }
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
