// The "how" that pairs with `defineCapability`'s "what". An implementer writes
// one flat object of typed functions and nothing else — no registration, no
// error plumbing, no transport, no ids. Which arm of the seam each function
// lands behind (`invoke` vs `subscribe`) is decided by the kernel, which only
// ever calls `subscribe` for methods the app declared as `Stream`s; the impl
// never thinks about routing.
//
//   unary  : (input, ctx) => output
//   stream : (input, emit, ctx) => Unsubscribe   // call emit on each event
//
// Both ends are typed off the SAME contract: `Impl<C>` derives each function's
// argument and result types from the contract's `Methods`/`Streams` surfaces.

import type { Stream } from './core.ts'
import { CapabilityError } from './error.ts'
import type { Capability, CapabilityCall, Unsubscribe } from './types.ts'

// The trusted metadata the kernel already attached. Scope→resource resolution
// lives here (e.g. `resolveVolume`); capabilities that don't need it ignore it.
type Ctx = { appId: string; scopes: readonly string[]; actor?: string }

// Pull the phantom `Methods`/`Streams` back out of a `defineCapability` factory.
type MethodsOf<C> = C extends (...a: never[]) => { __methods?: infer M } ? M : never
type StreamsOf<C> = C extends (...a: never[]) => { __streams?: infer S } ? S : never

type MethodImpl<F> = F extends (input: infer I) => infer O
	? (input: I, ctx: Ctx) => O | Promise<O>
	: never

type StreamImpl<F> = F extends (input: infer I) => Stream<infer E>
	? (input: I, emit: (event: E) => void, ctx: Ctx) => Unsubscribe | Promise<Unsubscribe>
	: never

// ONE homomorphic mapped type over every declared method + stream key, so TS
// instantiates it eagerly and contextually types each handler's params. An
// intersection of two mapped types (or a stream half behind a top-level
// `string extends keyof S ? … : …` conditional) is left un-instantiated when TS
// pulls contextual types, collapsing handler args to `any`. Streams take a key
// (they never collide with methods); the empty-streams default has `keyof =
// never`, so a stream-less capability needs no stream handlers.
type Impl<C, M = MethodsOf<C>, S = StreamsOf<C>> = {
	[K in keyof M | keyof S]: K extends keyof S
		? StreamImpl<S[K]>
		: K extends keyof M
			? MethodImpl<M[K]>
			: never
}

export function implementCapability<C>(_contract: C, impl: Impl<C>): Capability {
	const fn = (c: CapabilityCall) => {
		const f = (impl as Record<string, unknown>)[c.method]
		if (typeof f !== 'function')
			throw new CapabilityError('CAPABILITY_UNAVAILABLE', c.capability, c.method)
		return f as (...a: unknown[]) => unknown
	}
	const ctx = (c: CapabilityCall): Ctx => ({ appId: c.appId, scopes: c.scopes, actor: c.actor })
	return {
		invoke: async (c) => fn(c)(c.input, ctx(c)),
		subscribe: async (c, emit) => (await fn(c)(c.input, emit, ctx(c))) as Unsubscribe
	}
}
