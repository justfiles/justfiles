// The `_caps` wire on Cap'n Web. Same seam as the hand-rolled `proxy.ts`: a
// proxied `Capabilities` the registry uses as a `fallback` with no special-casing.
// Cap'n Web owns id correlation, function-by-reference (the subscribe `emit`
// callback and the returned `unsub`), and special-type serialization (Uint8Array,
// bigint, Date, …) that the JSON wire could not carry.
//
// Errors ride a result envelope, never thrown across RPC: `CapabilityError`'s
// custom `code`/`capability`/`method` don't survive Cap'n Web's `Error`
// serialization, so we relay them through `toWire`/`fromWire` as before.

import { RpcSession, type RpcTransport } from 'capnweb'
import { fromWire, toWire, type WireError } from './error.ts'
import type { Capabilities, CapabilityCall, Emit, Unsubscribe } from './types.ts'

// Scopes DO ride the wire, resolved by the EXECUTING kernel from the app's
// manifest (the isolate never supplies them). Authorization is a property of the
// bundle actually running the call, so the serving side honors the executing
// kernel's scopes rather than re-deriving them from its own (possibly different)
// copy of the bundle. An old peer that omits `scopes` is treated as scope-free.
interface WireCall {
	appId: string
	capability: string
	method: string
	args: readonly unknown[]
	scopes?: readonly string[]
}

type InvokeResult = { ok: true; value: unknown } | { ok: false; error: WireError }
type SubResult = { ok: true; unsub: Unsubscribe } | { ok: false; error: WireError }

// The server's main interface, exposed by reference over the session.
interface CapsServer {
	invoke(call: WireCall): Promise<InvokeResult>
	subscribe(call: WireCall, emit: Emit): Promise<SubResult>
}

const toCall = (w: WireCall): CapabilityCall => ({
	appId: w.appId,
	capability: w.capability,
	method: w.method,
	args: w.args,
	scopes: w.scopes ?? []
})

const toWireCall = (c: CapabilityCall): WireCall => ({
	appId: c.appId,
	capability: c.capability,
	method: c.method,
	args: c.args,
	scopes: c.scopes
})

// Cap'n Web disposes stubs via `Symbol.dispose`, falling back to `Symbol.for` the
// same way it does internally. Resolved dynamically so this module needs no
// `esnext.disposable` lib — consumers compile it under varying `lib` settings.
const disposeSymbol: symbol = (Symbol as { dispose?: symbol }).dispose ?? Symbol.for('dispose')
const dispose = (stub: unknown): void => {
	const off = (stub as Record<symbol, unknown>)[disposeSymbol]
	if (typeof off === 'function') (off as () => void).call(stub)
}

// Attach a `Symbol.dispose` to a function so Cap'n Web runs `cleanup` when it
// disposes the exported stub on session teardown (`disposeRpcTarget`), not only
// when the peer calls it. A bare function has no disposer, so a broken session
// would never run the cleanup.
const withDisposer = (fn: Unsubscribe, cleanup: () => void): Unsubscribe => {
	;(fn as unknown as Record<symbol, unknown>)[disposeSymbol] = cleanup
	return fn
}

// Take an independent reference to a parameter stub so it survives past the call
// that delivered it — Cap'n Web disposes call params on return (`deliverCall`).
const dup = (emit: Emit): Emit => {
	const d = (emit as Partial<{ dup(): Emit }>).dup
	return d ? d.call(emit) : emit
}

function capsServer(local: Capabilities): CapsServer {
	return {
		invoke: async (call) => {
			try {
				return { ok: true, value: await local.invoke(toCall(call)) }
			} catch (error) {
				return { ok: false, error: toWire(error) }
			}
		},
		// `emit` arrives as a stub (the client's callback by reference). The local
		// backend keeps calling it until torn down; on unsub we drop the local
		// subscription and release the stub (no auto-GC — see Cap'n Web).
		subscribe: async (call, emit) => {
			// `emit` is a parameter stub — disposed when this call returns — so dup it
			// to keep the backend's callback alive for the subscription's lifetime.
			const sink = dup(emit)
			try {
				// Guard the emit: an abrupt teardown (transport abort / DO hibernate)
				// disposes the stub, and a late local event would otherwise throw
				// "already disposed" out of the backend's own callback. Dispose the
				// fire-and-forget call's result so its import entry doesn't leak.
				const off = await local.subscribe(toCall(call), (event) => {
					try {
						dispose(sink(event))
					} catch {}
				})
				// One idempotent teardown, run on EITHER the peer calling unsub OR
				// Cap'n Web disposing the exported stub when the session breaks.
				let torn = false
				const cleanup = () => {
					if (torn) return
					torn = true
					off()
					dispose(sink)
				}
				return { ok: true, unsub: withDisposer(() => cleanup(), cleanup) }
			} catch (error) {
				dispose(sink)
				return { ok: false, error: toWire(error) }
			}
		}
	}
}

// Provider side: serve `local` over the transport. There is no server->client
// call path (the volume poke rides the session `/ws` socket, not this capability
// session), so nothing is returned; the session self-retains via its transport
// receive loop.
export function serveCapabilitiesRpc(transport: RpcTransport, local: Capabilities): void {
	void new RpcSession(transport, capsServer(local))
}

export interface CapsProxy {
	caps: Capabilities
	// Self-heal hook: fires when the RPC session breaks (peer gone / transport
	// error), so the caller can drop a cached connection and reopen on next use.
	onBroken(cb: () => void): void
	// Release the session — disposes the remote main stub.
	dispose(): void
}

// Caller side: adapt the remote main into a `Capabilities`.
export function proxyCapabilitiesRpc(transport: RpcTransport): CapsProxy {
	const session = new RpcSession<CapsServer>(transport)
	const remote = session.getRemoteMain()
	const caps: Capabilities = {
		invoke: async (call) => {
			const res = await remote.invoke(toWireCall(call))
			if (res.ok) return res.value
			throw fromWire(res.error, { capability: call.capability, method: call.method })
		},
		// A live `unsub` flag stops routing the instant the caller unsubscribes —
		// events already in flight from the server are dropped, matching the old
		// proxy's synchronous client-side stop.
		subscribe: async (call, emit) => {
			let live = true
			const res = await remote.subscribe(toWireCall(call), (event) => {
				if (live) emit(event)
			})
			if (!res.ok) {
				live = false
				throw fromWire(res.error, { capability: call.capability, method: call.method })
			}
			const unsub = res.unsub
			return () => {
				if (!live) return
				live = false
				// Send the unsub, THEN release the stub — disposing it eagerly cancels
				// the in-flight call before the server tears the subscription down.
				Promise.resolve(unsub())
					.catch(() => {})
					.finally(() => dispose(unsub))
			}
		}
	}
	return {
		caps,
		onBroken: (cb) => remote.onRpcBroken(() => cb()),
		dispose: () => dispose(remote)
	}
}
