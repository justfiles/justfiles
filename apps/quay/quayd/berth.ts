// The webview ⇄ kernel channel (Slice 7): a per-connection, token-scoped Cap'n Web
// session on quayd. The booter's `boot.js` opens a socket to `/berth?app=<id>` and
// gets a typed stub to this `Berth`, scoped to that one app. dispatch/state forward
// to the kernel; subscribe takes the client's `onState` callback *by reference*
// (Cap'n Web's function-passing) and drives it off `app.update` — the same kernel
// the agent dispatches into, so updates fan out with no sync/watch.

import { RpcSession, RpcTarget, type RpcTransport } from 'capnweb'
import type { WebSocket } from 'ws'

// The slice of the kernel a berth needs. main.ts implements it directly over the
// kernel; tests pass a stub.
export interface BerthBackend {
	state(appId: string): Promise<unknown>
	dispatch(appId: string, message: unknown): Promise<unknown>
	subscribe(appId: string, onState: (state: unknown) => void): () => void
}

type Emit = (value: unknown) => unknown

// Open a Cap'n Web session over `ws`, serving a `Berth` scoped to `appId`. All
// kernel subscriptions opened by the berth are torn down when the socket closes.
export function serveBerth(ws: WebSocket, backend: BerthBackend, appId: string): void {
	const subs = new Set<() => void>()
	const { transport, feed } = wsTransport(ws)
	new RpcSession(transport, new Berth(appId, backend, subs))
	ws.on('message', (data) => feed(data.toString()))
	ws.on('close', () => {
		for (const teardown of [...subs]) teardown()
		transport.abort?.(new Error('socket closed'))
	})
}

class Berth extends RpcTarget {
	constructor(
		private readonly appId: string,
		private readonly backend: BerthBackend,
		private readonly subs: Set<() => void>
	) {
		super()
	}

	state(): Promise<unknown> {
		return this.backend.state(this.appId)
	}

	dispatch(message: unknown): Promise<unknown> {
		return this.backend.dispatch(this.appId, message)
	}

	subscribe(onState: Emit): () => void {
		// `onState` is a call-parameter stub — Cap'n Web disposes it when this call
		// returns — so dup it to keep the client callback alive for the subscription.
		const sink = dup(onState)
		const off = this.backend.subscribe(this.appId, (state) => {
			try {
				dispose(sink(state)) // release the fire-and-forget call's import entry
			} catch {} // a late event after teardown disposed the stub
		})
		let torn = false
		const teardown = (): void => {
			if (torn) return
			torn = true
			off()
			this.subs.delete(teardown)
			dispose(sink)
		}
		this.subs.add(teardown)
		// Returned by reference: the client calls it to unsubscribe; Cap'n Web also
		// runs the disposer if the session breaks first.
		return withDisposer(() => teardown(), teardown)
	}
}

// A pull-based transport feeding Cap'n Web from a node `ws` socket (mirrors
// `@justfiles/app`'s `wsFeedTransport`, kept local so quay adds no public surface
// to the app package). Frames are JSON strings; `ws.on('message')` pushes them in.
function wsTransport(ws: WebSocket): { transport: RpcTransport; feed: (frame: string) => void } {
	const queue: string[] = []
	const waiters: Array<{ resolve: (m: string) => void; reject: (e: unknown) => void }> = []
	let failure: unknown

	const transport: RpcTransport = {
		send: async (message) => ws.send(message),
		receive: () =>
			new Promise<string>((resolve, reject) => {
				const next = queue.shift()
				if (next !== undefined) resolve(next)
				else if (failure) reject(failure)
				else waiters.push({ resolve, reject })
			}),
		abort: (reason) => {
			if (failure) return
			failure = reason ?? new Error('aborted')
			for (const w of waiters) w.reject(failure)
			waiters.length = 0
			ws.close()
		}
	}

	const feed = (frame: string): void => {
		const w = waiters.shift()
		if (w) w.resolve(frame)
		else queue.push(frame)
	}

	return { transport, feed }
}

// Cap'n Web disposes stubs via `Symbol.dispose` (Symbol.for fallback), the same way
// it does internally — resolved dynamically so this needs no `esnext.disposable` lib.
const disposeSymbol: symbol = (Symbol as { dispose?: symbol }).dispose ?? Symbol.for('dispose')

function dispose(stub: unknown): void {
	const off = (stub as Record<symbol, unknown> | null)?.[disposeSymbol]
	if (typeof off === 'function') (off as () => void).call(stub)
}

// Take an independent reference so the callback survives past the call that
// delivered it (Cap'n Web disposes call params on return).
function dup(emit: Emit): Emit {
	const d = (emit as Partial<{ dup(): Emit }>).dup
	return d ? d.call(emit) : emit
}

// Attach a disposer so Cap'n Web runs `cleanup` on session teardown, not only when
// the peer calls the returned unsub.
function withDisposer(fn: () => void, cleanup: () => void): () => void {
	;(fn as unknown as Record<symbol, unknown>)[disposeSymbol] = cleanup
	return fn
}
